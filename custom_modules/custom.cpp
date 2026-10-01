/*
###############################################################################
# 3D cerebral organoid, MOSAIC variant — custom module                        #
###############################################################################
*/

#include "./custom.h"
#include <fstream>

// Geometry of the solid ball, refreshed once per mechanics step.
std::vector<double> organoid_centre( 3, 0.0 );
double organoid_radius = 0.0;
int organoid_epithelial_cells = 0;

// Cached indices, resolved once the definitions and microenvironment exist.
static int OXYGEN = -1, DLL = -1, CT1 = -1;
static Cell_Definition* pNE = NULL;
static Cell_Definition* pARG = NULL;
static Cell_Definition* pORG = NULL;
static Cell_Definition* pIPC = NULL;
static Cell_Definition* pDeep = NULL;
static Cell_Definition* pUpper = NULL;
static Cell_Definition* pAstro = NULL;
static Cell_Definition* pNEv = NULL;

void create_cell_types( void )
{
	// The generator is already seeded from <options><random_seed>.
	initialize_default_cell_definition();
	cell_defaults.phenotype.secretion.sync_to_microenvironment( &microenvironment );

	cell_defaults.functions.volume_update_function = standard_volume_update_function;
	cell_defaults.functions.update_velocity = organoid_velocity_function;
	cell_defaults.functions.update_migration_bias = NULL;
	cell_defaults.functions.update_phenotype = NULL;
	cell_defaults.functions.custom_cell_rule = organoid_cell_rule;
	cell_defaults.functions.contact_function = NULL;
	cell_defaults.functions.cell_division_function = count_division;

	cell_defaults.functions.add_cell_basement_membrane_interactions = NULL;
	cell_defaults.functions.calculate_distance_to_membrane = NULL;

	initialize_cell_definitions_from_pugixml();

	// Every definition inherits the organoid hooks; the XML loader does not
	// copy function pointers onto definitions it creates. Note this replaces
	// the standard_asymmetric_division_function the loader installs for types
	// with asymmetric division enabled — count_division chains to it.
	for( int i = 0; i < cell_definitions_by_index.size(); i++ )
	{
		Cell_Definition* pCD = cell_definitions_by_index[i];
		pCD->functions.update_velocity = organoid_velocity_function;
		pCD->functions.custom_cell_rule = organoid_cell_rule;
		pCD->functions.cell_division_function = count_division;
		pCD->functions.update_phenotype = NULL;
	}

	OXYGEN = microenvironment.find_density_index( "oxygen" );
	DLL = microenvironment.find_density_index( "dll" );
	CT1 = microenvironment.find_density_index( "ct1" );

	pNE = find_cell_definition( "NE" );
	pARG = find_cell_definition( "apical RG" );
	pORG = find_cell_definition( "oRG" );
	pIPC = find_cell_definition( "IPC" );
	pDeep = find_cell_definition( "deep neuron" );
	pUpper = find_cell_definition( "upper neuron" );
	pAstro = find_cell_definition( "astrocyte" );
	pNEv = find_cell_definition( "variant NE" );

	// Pharmacology, applied to the definitions before any cell exists.
	// DAPT and other gamma-secretase inhibitors block Notch reception; with a
	// diffusible ligand proxy the equivalent move is to mute the ligand.
	double notch_block = parameters.doubles( "notch_inhibition" );
	if( notch_block > 0.0 )
	{
		if( notch_block > 1.0 )
		{ notch_block = 1.0; }
		for( int i = 0; i < cell_definitions_by_index.size(); i++ )
		{
			cell_definitions_by_index[i]->phenotype.secretion.secretion_rates[DLL] *= ( 1.0 - notch_block );
		}
		std::cout << "Notch signalling reduced to " << 100.0 * ( 1.0 - notch_block ) << "% (DAPT-like)" << std::endl;
	}

	// CNTF/LIF-like potentiation of the gliogenic cue scales the neuronal source.
	double glio = parameters.doubles( "gliogenic_potency" );
	if( glio != 1.0 )
	{
		pDeep->phenotype.secretion.secretion_rates[CT1] *= glio;
		pUpper->phenotype.secretion.secretion_rates[CT1] *= glio;
		std::cout << "CT-1 secretion scaled by " << glio << " (CNTF/LIF-like)" << std::endl;
	}

	build_cell_definitions_maps();
	setup_signal_behavior_dictionaries();
	setup_cell_rules();

	display_cell_definitions( std::cout );
	return;
}

void setup_microenvironment( void )
{
	// Oxygen arrives from the medium via the Dirichlet boundary set in the XML;
	// dll and ct1 are made by the cells. Nothing to override here.
	initialize_microenvironment();
	return;
}

/**
 * Seed the organoid: a compact ball of neuroepithelial cells, the state of an
 * embryoid body at neural induction.
 */
void setup_tissue( void )
{
	int n = parameters.ints( "seed_cells" );
	double seed_radius = parameters.doubles( "seed_radius" );

	// A radius of zero means "whatever packs these cells into a solid ball".
	// Using the same relation as update_organoid_geometry means the seed
	// starts exactly on its confinement sphere rather than being squeezed.
	if( seed_radius <= 0.0 )
	{
		double volume = n * pNE->phenotype.volume.total;
		double packing = parameters.doubles( "matrigel_packing" );
		if( packing < 0.1 )
		{ packing = 0.1; }
		seed_radius = cbrt( 3.0 * volume / ( 4.0 * M_PI * packing ) );
	}

	// The mosaic clone: variant founders spread evenly through the seeding
	// order (Bresenham spacing), so the clone starts interspersed rather than
	// as one contiguous patch.
	double fraction = parameters.doubles( "variant_fraction" );
	if( fraction < 0.0 ) { fraction = 0.0; }
	if( fraction > 1.0 ) { fraction = 1.0; }
	int n_variant = (int) round( fraction * n );
	if( pNEv == NULL ) { n_variant = 0; }

	std::vector<int> variant_ids;

	// A sunflower-spiral ball: radii go as cbrt(i/n) for uniform density, and
	// directions advance by the golden angle so no two cells stack.
	const double golden = M_PI * ( 3.0 - sqrt( 5.0 ) );
	for( int i = 0; i < n; i++ )
	{
		double u = ( i + 0.5 ) / n;
		double radius = seed_radius * cbrt( u );
		double y = 1.0 - 2.0 * u;
		double ring = sqrt( std::max( 0.0, 1.0 - y * y ) );
		double theta = golden * i;

		std::vector<double> position( 3, 0.0 );
		position[0] = radius * ring * cos( theta );
		position[1] = radius * y;
		position[2] = radius * ring * sin( theta );

		bool variant = ( (long) ( i + 1 ) * n_variant ) / n > ( (long) i * n_variant ) / n;
		Cell* pC = create_cell( variant ? *pNEv : *pNE );
		pC->assign_position( position );
		if( variant )
		{ variant_ids.push_back( pC->ID ); }
	}

	// The founder IDs of the variant clone, for descendant analysis later.
	std::ofstream vf( PhysiCell_settings.folder + "/variant_founders.csv" );
	vf << "ID" << std::endl;
	for( int i = 0; i < variant_ids.size(); i++ )
	{ vf << variant_ids[i] << std::endl; }
	vf.close();

	organoid_centre = { 0.0, 0.0, 0.0 };
	organoid_radius = seed_radius;
	organoid_epithelial_cells = n;

	std::cout << "Seeded organoid: " << n - (int) variant_ids.size() << " wild-type + "
		<< variant_ids.size() << " variant neuroepithelial cells in a "
		<< seed_radius << " micron ball." << std::endl;
	return;
}

void update_organoid_geometry( void )
{
	// Called from the main loop at the mechanics cadence; single threaded.
	static double next_update = -1.0;
	const double dt = PhysiCell::mechanics_dt;
	if( PhysiCell_globals.current_time < next_update - 1e-9 )
	{ return; }
	next_update = PhysiCell_globals.current_time + dt;

	std::vector<double> sum( 3, 0.0 );
	double volume = 0.0;
	int n = 0;

	for( int i = 0; i < (*all_cells).size(); i++ )
	{
		Cell* pC = (*all_cells)[i];
		if( pC->phenotype.death.dead == true )
		{ continue; }
		sum[0] += pC->position[0];
		sum[1] += pC->position[1];
		sum[2] += pC->position[2];
		volume += pC->phenotype.volume.total;
		n++;
	}

	organoid_epithelial_cells = n;
	if( n == 0 )
	{ return; }

	organoid_centre[0] = sum[0] / n;
	organoid_centre[1] = sum[1] / n;
	organoid_centre[2] = sum[2] / n;

	// A solid ball at the target packing fraction: V_cells = phi * (4/3) pi R^3.
	double packing = parameters.doubles( "matrigel_packing" );
	if( packing < 0.1 )
	{ packing = 0.1; }
	double target = cbrt( 3.0 * volume / ( 4.0 * M_PI * packing ) );

	// Never squeeze below a single cell.
	double floor_radius = 1.5 * (*all_cells)[0]->phenotype.geometry.radius;
	if( target < floor_radius )
	{ target = floor_radius; }

	// Ease toward the target so the boundary does not jump between steps.
	if( organoid_radius <= 0.0 )
	{ organoid_radius = target; }
	else
	{ organoid_radius += 0.05 * ( target - organoid_radius ); }

	return;
}

void organoid_velocity_function( Cell* pCell, Phenotype& phenotype, double dt )
{
	standard_update_cell_velocity( pCell, phenotype, dt );

	std::vector<double> radial( 3, 0.0 );
	radial[0] = pCell->position[0] - organoid_centre[0];
	radial[1] = pCell->position[1] - organoid_centre[1];
	radial[2] = pCell->position[2] - organoid_centre[2];

	double d = sqrt( radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2] );
	if( d < 1e-6 )
	{ return; }

	// The Matrigel droplet: one-sided confinement that returns strays to the
	// ball. Inside the ball the tissue holds itself together by adhesion.
	double overshoot = d - organoid_radius;
	if( overshoot > 0.0 )
	{
		double speed = -parameters.doubles( "confinement_stiffness" ) * overshoot;
		const double max_speed = parameters.doubles( "confinement_max_speed" );
		if( speed < -max_speed ) { speed = -max_speed; }
		pCell->velocity[0] += speed * radial[0] / d;
		pCell->velocity[1] += speed * radial[1] / d;
		pCell->velocity[2] += speed * radial[2] / d;
	}

	if( phenotype.death.dead == true )
	{ return; }

	// Newborn neurons migrate radially outward — glial-guided locomotion along
	// the radial-glia scaffold — and settle into the cortical-plate shell.
	if( pCell->type == pDeep->type || pCell->type == pUpper->type )
	{
		double shell = parameters.doubles( "neuron_migration_shell" ) * organoid_radius;
		if( d < shell )
		{
			double speed = parameters.doubles( "neuron_migration_speed" );
			pCell->velocity[0] += speed * radial[0] / d;
			pCell->velocity[1] += speed * radial[1] / d;
			pCell->velocity[2] += speed * radial[2] / d;
		}
	}

	return;
}

void organoid_cell_rule( Cell* pCell, Phenotype& phenotype, double dt )
{
	if( phenotype.death.dead == true )
	{ return; }

	// ---- division counter follows the cell's identity, not its ancestry ----
	// A daughter inherits its parent's counter (and an asymmetric division or a
	// transformation changes type without touching custom data), so detect the
	// type change here and restart the count: an IPC's cap counts *its own*
	// amplifying divisions, not its radial-glia mother's life story.
	if( (int) pCell->custom_data["last_type"] != pCell->type )
	{
		pCell->custom_data["divisions"] = 0.0;
		pCell->custom_data["last_type"] = pCell->type;
	}

	// ---- the IPC amplifying compartment is finite ---------------------------
	// Rules can set a differentiation *rate*, but not "after two divisions".
	// An IPC that reaches the cap becomes a neuron immediately, taking
	// whichever layer branch the rules currently favour — early in the run
	// that is deep-layer, late it is upper-layer (inside-out neurogenesis).
	if( pCell->type == pIPC->type
		&& pCell->custom_data["divisions"] >= parameters.ints( "ipc_division_limit" ) )
	{
		double deep = get_single_behavior( pCell, "transform to deep neuron" );
		double upper = get_single_behavior( pCell, "transform to upper neuron" );
		Cell_Definition* pFate = ( deep >= upper ) ? pDeep : pUpper;
		pCell->convert_to_cell_definition( *pFate );
		pCell->custom_data["divisions"] = 0.0;
		pCell->custom_data["last_type"] = pCell->type;
	}

	return;
}

void count_division( Cell* pParent, Cell* pDaughter )
{
	// Installing this hook displaced the standard asymmetric-division hook the
	// XML loader set for the radial glia, so run that draw first: it may
	// convert the daughter (aRG -> IPC / oRG, the neurogenic divisions).
	if( pParent->phenotype.cycle.asymmetric_division.probabilities_total() > 1e-12 )
	{ standard_asymmetric_division_function( pParent, pDaughter ); }

	// copy_data has already run, so the daughter carries the parent's count;
	// organoid_cell_rule resets it if the type changed above.
	pParent->custom_data["divisions"] += 1.0;
	pDaughter->custom_data["divisions"] += 1.0;
	return;
}

std::vector<std::string> organoid_coloring_function( Cell* pCell )
{
	// Same hues as the viewer's categorical palette, so the SVG snapshots and
	// the 3D viewer agree on what each type looks like.
	static std::vector<std::string> palette = {
		"rgb(57,135,229)",   // NE
		"rgb(217,89,38)",    // apical RG
		"rgb(25,158,112)",   // oRG
		"rgb(201,133,0)",    // IPC
		"rgb(213,81,129)",   // deep neuron
		"rgb(0,131,0)",      // upper neuron
		"rgb(144,133,233)",  // astrocyte
		"rgb(230,103,103)",  // variant NE
		"rgb(0,163,163)"     // variant RG
	};

	std::vector<std::string> output( 4, "rgb(120,120,120)" );

	if( pCell->phenotype.death.dead == true )
	{
		output[0] = "rgb(60,60,60)";
		output[2] = "rgb(40,40,40)";
		output[3] = "rgb(40,40,40)";
		return output;
	}

	std::string colour = palette[ pCell->type % palette.size() ];
	output[0] = colour;
	output[1] = colour;
	output[2] = colour;
	output[3] = colour;

	return output;
}

void log_organoid_composition( std::string filename, bool write_header )
{
	std::ofstream out;
	out.open( filename.c_str(), write_header ? std::ios::out : std::ios::app );
	if( out.fail() )
	{ return; }

	int n_types = cell_definitions_by_index.size();
	if( write_header )
	{
		out << "time,radius,total";
		for( int i = 0; i < n_types; i++ )
		{ out << "," << cell_definitions_by_index[i]->name; }
		out << ",dead" << std::endl;
	}

	std::vector<int> counts( n_types, 0 );
	int dead = 0;
	for( int i = 0; i < (*all_cells).size(); i++ )
	{
		Cell* pC = (*all_cells)[i];
		if( pC->phenotype.death.dead == true ) { dead++; continue; }
		if( pC->type >= 0 && pC->type < n_types )
		{ counts[pC->type]++; }
	}

	out << PhysiCell_globals.current_time << "," << organoid_radius << "," << (*all_cells).size();
	for( int i = 0; i < n_types; i++ )
	{ out << "," << counts[i]; }
	out << "," << dead << std::endl;
	out.close();
	return;
}
