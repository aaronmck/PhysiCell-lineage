/*
###############################################################################
# 3D cerebral (dorsal forebrain) organoid                                     #
#                                                                             #
# Seven cell types on the canonical excitatory-cortex lineage, from 100       #
# neuroepithelial founders. Fate transitions live in config/cell_rules.csv;   #
# this module supplies the parts PhysiCell's rules engine cannot express:     #
#                                                                             #
#   - the Matrigel droplet that keeps the population one compact sphere       #
#   - outward migration of newborn neurons toward the cortical-plate shell    #
#   - the division counter that bounds the IPC amplifying compartment         #
#   - chaining of asymmetric division into the lineage-counting hook          #
#                                                                             #
# See README.md in this project for the biology and the parameter sources.    #
###############################################################################
*/

#include "../core/PhysiCell.h"
#include "../modules/PhysiCell_standard_modules.h"

using namespace BioFVM;
using namespace PhysiCell;

// ------------------------------------------------------------------- setup

void create_cell_types( void );
void setup_tissue( void );
void setup_microenvironment( void );

// --------------------------------------------------------------- rendering

std::vector<std::string> organoid_coloring_function( Cell* );

// ------------------------------------------------------------- cell hooks

/** Per-cell: division-counter reset on type change, and the IPC division cap. */
void organoid_cell_rule( Cell* pCell, Phenotype& phenotype, double dt );

/** Standard mechanics plus Matrigel confinement and neuron outward migration. */
void organoid_velocity_function( Cell* pCell, Phenotype& phenotype, double dt );

/**
 * Division hook: runs the standard asymmetric-division draw (the XML loader's
 * own hook, which installing this one replaces) and counts the division for
 * the IPC cap.
 */
void count_division( Cell* pParent, Cell* pDaughter );

// ------------------------------------------------------ organoid geometry

/**
 * Recompute the organoid centre and the radius a solid ball of the current
 * population would have. Call once per mechanics step from the main loop: it
 * walks every cell and must not run inside an OpenMP region.
 */
void update_organoid_geometry( void );

/** Centre of the live organoid, in microns. */
extern std::vector<double> organoid_centre;

/** Radius the population is currently being confined to, in microns. */
extern double organoid_radius;

/** Live cells at the last geometry update. */
extern int organoid_epithelial_cells;

/** One line per cell type, appended to a CSV so composition can be tracked. */
void log_organoid_composition( std::string filename, bool write_header );
