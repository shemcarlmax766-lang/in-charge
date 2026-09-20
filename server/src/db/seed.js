/**
 * Demo data.
 *
 * NOTHING in this file is real. The department, the people, the serial numbers, the faults
 * and the costs are invented for evaluation, so a reviewer can see the workflow, the charts
 * and the risk model working on a plausible fleet. The banner printed at the end of seeding
 * says the same thing, and the client renders a persistent "DEMO DATA" ribbon while the
 * seeded marker is present in app_settings.
 *
 * Deterministic: a fixed PRNG seed means the same data every run, which is what makes the
 * assertion-based tests and the chart screenshots repeatable.
 *
 * It inserts through plain SQL rather than the services, but every derived field (SLA
 * due_at, equipment status, status history, diagnosis_confirmed, PM dates) is written to
 * agree with the live state machine, so seeded data is indistinguishable from used data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { hashPassword } from '../lib/password.js';
import { assetTag, reference, generatePassword } from '../lib/tokens.js';
import { migrate } from '../lib/db.js';
import { nextSequence } from '../lib/db.js';
import { STATUS_META, OPEN_FAULT_STATUSES, FAULT_TO_EQUIPMENT_STATUS } from '../services/equipment.status.js';
import { DEFAULT_SLA_HOURS } from '../services/fault.service.js';

/* ------------------------------------------------------------------ rng ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260913);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const chance = (p) => rnd() < p;
const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
const dateOnly = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n, jitterHours = 0) => new Date(Date.now() - n * 86_400_000 - jitterHours * 3_600_000);

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const sevWeighted = () => {
  const r = rnd();
  if (r < 0.42) return 'low';
  if (r < 0.75) return 'medium';
  if (r < 0.93) return 'high';
  return 'critical';
};

/* ----------------------------------------------------------------- people -- */
const PEOPLE = [
  { full_name: 'Dr. Amelia Okonkwo', email: 'a.okonkwo@sthospital-training.edu', role: 'admin', job_title: 'Head of Biomedical Engineering', department: 'Biomedical Engineering', employee_id: 'BME-001' },
  { full_name: 'Samuel Adeyemi', email: 's.adeyemi@sthospital-training.edu', role: 'admin', job_title: 'Department Administrator', department: 'Biomedical Engineering', employee_id: 'BME-002' },
  { full_name: 'Grace Mbeki', email: 'g.mbeki@sthospital-training.edu', role: 'technician', job_title: 'Senior Biomedical Engineer', department: 'Biomedical Engineering', employee_id: 'BME-101' },
  { full_name: 'Tunde Balogun', email: 't.balogun@sthospital-training.edu', role: 'technician', job_title: 'Biomedical Technician (Imaging)', department: 'Biomedical Engineering', employee_id: 'BME-102' },
  { full_name: 'Lindiwe Dube', email: 'l.dube@sthospital-training.edu', role: 'technician', job_title: 'Biomedical Technician (Life Support)', department: 'Biomedical Engineering', employee_id: 'BME-103' },
  { full_name: 'Kwame Mensah', email: 'k.mensah@sthospital-training.edu', role: 'technician', job_title: 'Trainee Technician', department: 'Biomedical Engineering', employee_id: 'BME-104' },
  { full_name: 'Nurse Practitioner R. Silva', email: 'r.silva@sthospital-training.edu', role: 'reporter', job_title: 'Clinical Skills Instructor', department: 'Nursing Skills Lab', employee_id: 'NUR-220' },
  { full_name: 'Lab Supervisor J. Achebe', email: 'j.achebe@sthospital-training.edu', role: 'reporter', job_title: 'Laboratory Supervisor', department: 'Physiology', employee_id: 'LAB-045' },
  { full_name: 'Priya Nair', email: 'p.nair@student.sthospital-training.edu', role: 'reporter', job_title: 'Biomedical Engineering Student (Y3)', department: 'Student', employee_id: 'BM2026-041' },
  { full_name: 'Daniel Kim', email: 'd.kim@student.sthospital-training.edu', role: 'reporter', job_title: 'Clinical Medicine Student (Y2)', department: 'Student', employee_id: 'CM2026-118' },
  { full_name: 'Fatima Bello', email: 'f.bello@student.sthospital-training.edu', role: 'reporter', job_title: 'Biomedical Engineering Student (Y2)', department: 'Student', employee_id: 'BM2026-077' },
  { full_name: 'Tomás Herrera', email: 't.herrera@student.sthospital-training.edu', role: 'reporter', job_title: 'Nursing Student (Y1)', department: 'Student', employee_id: 'NU2026-302' },
  { full_name: 'Aisha Yusuf', email: 'a.yusuf@student.sthospital-training.edu', role: 'reporter', job_title: 'Medical Laboratory Science (Y3)', department: 'Student', employee_id: 'ML2026-019' },
];

/* --------------------------------------------------------------- catalogue -- */
const CATEGORIES = [
  { code: 'ECG', name: 'ECG Machine', description: '12-lead and handheld electrocardiographs' },
  { code: 'MON', name: 'Patient Monitor', description: 'Vital-sign bedside and transport monitors' },
  { code: 'CEN', name: 'Centrifuge', description: 'Clinical laboratory centrifuges' },
  { code: 'MIC', name: 'Microscope', description: 'Binocular, trinocular and teaching microscopes' },
  { code: 'BP', name: 'Blood Pressure Machine', description: 'Manual and automated sphygmomanometers' },
  { code: 'AUT', name: 'Autoclave', description: 'Steam sterilisers' },
  { code: 'INF', name: 'Infusion Pump', description: 'Volumetric and syringe pumps' },
  { code: 'DEF', name: 'Defibrillator', description: 'Manual and AED defibrillators' },
  { code: 'ULT', name: 'Ultrasound Scanner', description: 'Diagnostic ultrasound systems' },
  { code: 'INC', name: 'Incubator', description: 'Infant and microbiological incubators' },
  { code: 'SPA', name: 'Suction Apparatus', description: 'Medical suction units' },
  { code: 'SCO', name: 'Operating Light', description: 'Theatre lights and magnifiers' },
];

const FAULT_CATEGORIES = [
  { code: 'ELEC', name: 'Electrical', description: 'Power, charging, fuse, earth and leakage problems', default: 'high' },
  { code: 'MECH', name: 'Mechanical', description: 'Moving parts, pumps, valves, switches, buttons', default: 'medium' },
  { code: 'SW', name: 'Software', description: 'Frozen screens, error codes, settings, printing logic', default: 'medium' },
  { code: 'DISP', name: 'Display', description: 'Screen blank, lines, dim, touch failure', default: 'medium' },
  { code: 'SENS', name: 'Sensor', description: 'Spo2, temperature, pressure or electrode sensing', default: 'high' },
  { code: 'CBL', name: 'Cable / Connector', description: 'Leads, probes, sockets, breaks in cables', default: 'low' },
  { code: 'BAT', name: 'Battery / Power', description: 'Not holding charge, sudden shutdown, battery fault', default: 'high' },
  { code: 'CAL', name: 'Calibration', description: 'Out of tolerance, drift, failed verification', default: 'medium' },
  { code: 'OTH', name: 'Unknown / Other', description: 'Anything not fitting a category above', default: 'medium' },
];

const LOCATIONS = [
  { code: 'BML1', name: 'Biomedical Engineering Workshop', building: 'Block A', floor: 'Ground', room: 'A-004' },
  { code: 'BML2', name: 'Biomedical Lab 2', building: 'Block A', floor: 'First', room: 'A-112' },
  { code: 'ECGT', name: 'ECG Training Room', building: 'Block B', floor: 'Ground', room: 'B-007' },
  { code: 'PHYL', name: 'Physiology Lab', building: 'Block B', floor: 'Second', room: 'B-204' },
  { code: 'MICB', name: 'Microbiology Lab', building: 'Block C', floor: 'First', room: 'C-101' },
  { code: 'STER', name: 'Sterilisation Room', building: 'Block C', floor: 'Ground', room: 'C-002' },
  { code: 'NURSL', name: 'Nursing Skills Lab', building: 'Block D', floor: 'Ground', room: 'D-010' },
  { code: 'SIMU', name: 'Simulation Suite', building: 'Block D', floor: 'First', room: 'D-115' },
  { code: 'STORE', name: 'Equipment Store', building: 'Block A', floor: 'Basement', room: 'A-B01' },
  { code: 'IMG', name: 'Imaging Teaching Bay', building: 'Block E', floor: 'Ground', room: 'E-003' },
];

const FLEET = [
  ['ECG', '12-Lead ECG Workstation', 'Edan', 'SE-1200 Express', 'life_support', 2],
  ['ECG', 'Handheld ECG Trainer', 'Finicare', 'EP10A', 'low', 3],
  ['ECG', 'Resting ECG Machine', 'Bionet', 'BC-1200', 'medium', 4],
  ['ECG', 'Stress Test ECG Unit', 'GE', 'Casper XL', 'high', 1],
  ['MON', 'Bedside Patient Monitor', 'Mindray', 'ePM 12M', 'life_support', 6],
  ['MON', 'Transport Monitor', 'Edan', 'IM 20', 'life_support', 3],
  ['MON', 'Teaching Monitor Simulator', 'Gardner-Nichols', 'M700', 'low', 4],
  ['MON', 'Fetal Monitor', 'Sonicaid', 'Sonio F2', 'high', 2],
  ['CEN', 'Clinical Centrifuge 8-place', 'Hettich', 'EBA 200', 'medium', 4],
  ['CEN', 'Haematocrit Microcentrifuge', 'DLAB', 'DM0412', 'low', 6],
  ['CEN', 'Refrigerated Centrifuge', 'Eppendorf', '5424 R', 'high', 2],
  ['MIC', 'Binocular Teaching Microscope', 'Olympus', 'CX23', 'low', 18],
  ['MIC', 'Trinocular Research Microscope', 'Leica', 'DM750', 'medium', 3],
  ['MIC', 'Phase-contrast Microscope', 'Swift', 'Pro Max 4', 'medium', 4],
  ['BP', 'Automated BP Monitor', 'Omron', 'HBP-1320', 'medium', 8],
  ['BP', 'Aneroid BP Trainer Set', 'Riester', 'Premack', 'low', 10],
  ['BP', 'Dynamic BP Recorder', 'A&D', 'TM-2421', 'high', 2],
  ['AUT', 'Steam Autoclave 23 L', 'Tuttnauer', '2250E', 'high', 2],
  ['AUT', 'Portable Autoclave 18 L', 'W&H', 'DentaStar', 'medium', 2],
  ['INF', 'Volumetric Infusion Pump', 'B.Braun', 'Infusomat space', 'life_support', 12],
  ['INF', 'Syringe Pump', 'KD Medical', 'neLoss 305', 'life_support', 8],
  ['INF', 'Enteral Feeding Pump', 'Fresenius', 'Amika 2', 'high', 4],
  ['DEF', 'Manual Defibrillator Trainer', 'Physio-Control', 'LIFEPAK 15 (trainer)', 'high', 4],
  ['DEF', 'AED Cabinet Unit', 'ZOLL', 'AED 3', 'life_support', 3],
  ['ULT', 'Portable Ultrasound', 'Chison', 'iVis 1.0', 'medium', 3],
  ['ULT', 'Cart-based Ultrasound System', 'Mindray', 'M7', 'high', 1],
  ['INC', 'Infant Radiant Warmer', 'Drager', 'BabeWarm', 'life_support', 2],
  ['INC', 'CO2 Incubator', 'Thermo', 'Forma 311', 'high', 1],
  ['INC', 'Laboratory Bottle Roller', 'Bibby', 'RS12', 'low', 2],
  ['SPA', 'Portable Suction Unit', 'Laerdal', 'Suction Kit', 'medium', 5],
  ['SPA', 'Theatre Suction Canister Set', 'Medec', 'M9600', 'high', 3],
  ['SCO', 'Operating Light LED', 'Trumpf', 'S300', 'high', 2],
  ['SCO', 'Examination Light', 'Welch Allyn', 'WL95S', 'low', 6],
  ['MIC', 'Student Microscope (shared)', 'Amscope', 'M300', 'low', 24],
  ['ECG', 'ECG Electrode Tester', 'In-house', 'Bench jig', 'low', 1],
  ['MON', 'Central Station Display', 'Edan', 'CMS200', 'high', 1],
];

const PARTS = [
  ['P-ECG-L1', 'ECG lead-off resistor board', 'ECG', 48.5],
  ['P-ECG-THM', 'ECG thermal print head', 'Printing', 96.0],
  ['P-MON-SPO2', 'Spo2 sensor cable (adult)', 'Sensor', 34.9],
  ['P-MON-BAT', 'Monitor battery pack 4400 mAh', 'Power', 129.0],
  ['P-MON-SCR', '7" LCD assembly', 'Display', 210.0],
  ['P-CEN-LID', 'Centrifuge lid micro-switch', 'Mechanical', 22.4],
  ['P-CEN-BLT', 'Drive belt', 'Mechanical', 14.75],
  ['P-CEN-ROTOR', '8-place rotor', 'Mechanical', 165.0],
  ['P-MIC-OBJ', 'Objective lens 40×', 'Optics', 88.0],
  ['P-MIC-LAMP', 'Halogen lamp module 3V20W', 'Optics', 19.5],
  ['P-MIC-FOC', 'Focus gear set', 'Mechanical', 26.0],
  ['P-BP-CUFF', 'Adult BP cuff (velcro)', 'Consumable', 12.2],
  ['P-BP-VALVE', 'Aneroid valve assembly', 'Mechanical', 17.8],
  ['P-AUT-GSK', 'Autoclave door gasket', 'Seal', 54.6],
  ['P-AUT-SOL', 'Solenoid steam valve', 'Mechanical', 82.0],
  ['P-AUT-PRS', 'Pressure sensor', 'Sensor', 41.0],
  ['P-INF-PMP', 'Pump peristaltic mechanism', 'Mechanical', 152.0],
  ['P-INF-CLAMP', 'Set clamp assembly', 'Mechanical', 27.5],
  ['P-INF-BAT', 'Infusion pump battery', 'Power', 98.0],
  ['P-DEF-PAD', 'Defibrillator electrode pads', 'Consumable', 21.9],
  ['P-DEF-BAT', 'AED battery pack', 'Power', 196.0],
  ['P-ULT-PROBE', 'Ultrasound probe connector', 'Connector', 74.0],
  ['P-GEN-FUSE', 'Safety fuse kit (assorted)', 'Power', 3.4],
  ['P-GEN-KNB', 'Panel knob set', 'Mechanical', 5.6],
  ['P-GEN-CBL', 'Mains power cable', 'Cable', 8.9],
];

const FAULT_TEMPLATES = {
  ECG: [
    ['Leads off error on limb leads', 'SENS', 'Chest and limb leads show "lead-off" for LA and RL even with fresh electrodes. Trace is flat until the cable is wiggled.', 'CBL'],
    ['No printout from thermal printer', 'SW', 'Machine acquires the trace but the printed strip is blank; paper and head appear seated.', 'DISP'],
    ['Touch screen unresponsive on left half', 'DISP', 'The touch panel ignores input on the left third, so patient data cannot be entered.', 'DISP'],
    ['Will not power on from battery', 'BAT', 'Unit only runs on mains; the battery indicator flashes and it shuts down when unplugged.', 'BAT'],
    ['Wandering baseline on all traces', 'SENS', 'Baseline drifts badly on every lead; suspected electrode or earth problem.', 'ELEC'],
  ],
  MON: [
    ['Spo2 drops randomly during demo', 'SENS', 'SpO2 value disappears intermittently and the pleth waveform flattens, with the probe correctly fitted.', 'SENS'],
    ['Alarm silences itself', 'SW', 'Audible alarm stops without being acknowledged; only the visual indicator remains.', 'ELEC'],
    ['Screen shows vertical lines', 'DISP', 'Three vertical lines across the display make waveforms hard to read in a teaching setting.', 'DISP'],
    ['Battery drains in 15 minutes', 'BAT', 'Fully charged battery is flat after about 15 minutes; runtime should be around 4 hours.', 'BAT'],
    ['NIBP over-reads by ~20 mmHg', 'CAL', 'Automated cuff readings sit about 20 mmHg above the manual reference on the same arm.', 'CAL'],
  ],
  CEN: [
    ['Rotor will not reach speed', 'MECH', 'Speed drops and stalls above 3000 rpm with a burning smell near the motor cover.', 'MECH'],
    ['Lid lock fault', 'MECH', 'Machine refuses to start because the lid-locked signal is intermittent.', 'MECH'],
    ['Excessive vibration', 'MECH', 'Heavy vibration on run-up even with a balanced load; unit walks on the bench.', 'MECH'],
    ['Display error E-05 on start', 'SW', 'Error code E-05 appears on power-up and must be cleared twice to run.', 'SW'],
  ],
  MIC: [
    ['No illumination from lamp', 'ELEC', 'Lamp does not light at any brightness setting; fuse at the inlet looks intact.', 'ELEC'],
    ['Image blurred at 40×', 'OTH', 'One objective gives a permanently soft image at high power; the fine focus cannot recover it.', 'MECH'],
    ['Stage moves on its own', 'MECH', 'The mechanical stage slips forward while adjusting the slide.', 'MECH'],
    ['Focus knob stiff and grinding', 'MECH', 'Coarse focus is very hard to turn and makes a grinding noise.', 'MECH'],
  ],
  BP: [
    ['Cuff will not hold pressure', 'MECH', 'Bladder loses pressure during inflation so no reading is produced.', 'MECH'],
    ['Automated error "cuff too loose"', 'SENS', 'Valid cuff fit is repeatedly rejected, and the reading is abandoned.', 'SENS'],
    ['Aneroid needle sticks', 'CAL', 'Pointer does not return to zero and readings vary between users.', 'CAL'],
    ['Air leak from tube', 'CBL', 'Audible hiss from the tube near the connector; pressure cannot be built up.', 'CBL'],
  ],
  AUT: [
    ['Door will not seal / steam leak', 'MECH', 'Steam escapes from the door edge during the cycle and the chamber cannot hold pressure.', 'MECH'],
    ['Cycle aborts at 121 °C', 'SW', 'Program stops early and displays a fault; contents remain wet.', 'SW'],
    ['Temperature reading too low', 'CAL', 'Chamber temperature reads about 6 °C below the reference probe.', 'CAL'],
    ['Water not filling chamber', 'MECH', 'The reservoir does not fill; the cycle starts dry and trips.', 'MECH'],
  ],
  INF: [
    ['Occlusion alarm with free flow', 'SENS', 'Occlusion alarm sounds even when the set runs freely, so the pump stops useful infusion.', 'SENS'],
    ['Rate drifts during run', 'MECH', 'Actual delivered volume is about 8 % below the set rate after 30 minutes.', 'CAL'],
    ['Air-in-line false alarm', 'SENS', 'Air detector triggers constantly with a bubble-free line.', 'SENS'],
    ['Battery fault on transfer', 'BAT', 'Pump shuts off when unplugged during a transfer drill.', 'BAT'],
    ['Door clamp will not lock', 'MECH', 'The pump door does not hold the set; tubing slips out mid-run.', 'MECH'],
  ],
  DEF: [
    ['Charge fails to reach energy', 'ELEC', 'Device cannot complete charging at 200 J and displays a service prompt.', 'ELEC'],
    ['Pad connector broken', 'CBL', 'Electrode cable is loose in the socket; the device reports missing pads.', 'CBL'],
    ['Self-test fails daily', 'SW', 'Routine self-test reports "service due" and blocks use until the battery is cycled.', 'SW'],
    ['Battery expired warning', 'BAT', 'Battery is flagged as expired although the pack is within date.', 'BAT'],
  ],
  ULT: [
    ['Probe image noise / dropout', 'SENS', 'Grayscale image has heavy noise and drops out on two probe elements.', 'SENS'],
    ['Frozen on boot', 'SW', 'System stalls on the logo screen and needs a hard power cycle.', 'SW'],
    ['Transducer cable breaks image', 'CBL', 'Image disappears unless the probe cable is held at an angle.', 'CBL'],
    ['No freeze/save function', 'SW', 'Freeze and cine playback buttons are unresponsive during teaching scans.', 'SW'],
  ],
  INC: [
    ['Temperature overshoots setpoint', 'CAL', 'Chamber runs 2.5 °C above the setpoint and alarms repeatedly.', 'CAL'],
    ['CO2 not regulating', 'SENS', 'CO2 concentration does not hold; sensor reading is flat.', 'SENS'],
    ['Humidity alarm continuously', 'SW', 'Low-humidity alarm sounds even with a full water tray.', 'SW'],
    ['Fan noise and vibration', 'MECH', 'Loud bearing noise from the circulation fan.', 'MECH'],
  ],
  SPA: [
    ['Weak suction pressure', 'MECH', 'Negative pressure does not reach the specified level with the canister sealed.', 'MECH'],
    ['Motor cuts out when warm', 'ELEC', 'Runs for a few minutes then stops, restarting after cooling.', 'ELEC'],
    ['Tubing connectors leak air', 'CBL', 'Loss of prime from the disposable tubing connection.', 'CBL'],
  ],
  SCO: [
    ['Light output dim', 'ELEC', 'Illuminance far below specification; handle brightness range is useless.', 'ELEC'],
    ['Arm will not hold position', 'MECH', 'The mounting arm slowly droops once positioned.', 'MECH'],
    ['Flicker on camera view', 'SW', 'Visible flicker under the light in the teaching camera feed.', 'DISP'],
  ],
  OTH: [['General fault requiring assessment', 'OTH', 'The device is not behaving normally and needs a technician assessment.', 'OTH']],
};

const RESOLUTIONS = [
  { diag: 'Intermittent break inside the lead cable near the connector', root: 'Cable fatigue from repeated wrapping around the unit', fix: 'Replaced the patient cable; issued a storage sleeve and briefed the lab supervisor', parts: ['P-ECG-L1'], tests: 'All 12 leads show continuous trace; 30-minute wiggle test passed; leakage current 8 µA (limit 100 µA)' },
  { diag: 'Thermal print head contaminated with residue from cheap paper', root: 'Non-specified consumable stock', fix: 'Cleaned the head, replaced paper, verified auto-cutter', parts: [], tests: '20 test strips print with legible waveform and calibrations' },
  { diag: 'Failing LCD digitiser layer', root: 'Age-related delamination of the touch sensor', fix: 'Replaced display assembly', parts: ['P-MON-SCR'], tests: 'Full touch grid test passed; brightness uniformity checked' },
  { diag: 'Battery no longer holds capacity', root: 'End of service life after about 700 cycles', fix: 'Fitted new battery pack, recalibrated gauge', parts: ['P-MON-BAT'], tests: 'Runtime 4 h 05 min at nominal load, discharge cut-off correct' },
  { diag: 'Contaminated / damaged sensor cable', root: 'Cable kinked and connector pins bent during cleaning', fix: 'Replaced sensor cable, counselled on cleaning method', parts: ['P-MON-SPO2'], tests: 'Spo2 simulates 70–100 % correctly, no dropouts over 2 h' },
  { diag: 'Calibration drift on the NIBP pressure transducer', root: 'Reference drift after transport shock', fix: 'Recalibrated against a mercury-free reference and re-verified at 50/150/250 mmHg', parts: [], tests: 'Within ±3 mmHg across the range (limit ±5)', cal: true },
  { diag: 'Worn drive belt causing slip', root: 'Normal wear plus overload of teaching runs', fix: 'Replaced belt, checked rotor balance', parts: ['P-CEN-BLT'], tests: 'Reaches and holds 4000 rpm; vibration 0.4 mm/s; lid interlock verified' },
  { diag: 'Failing lid micro-switch', root: 'Switch contact oxidation from humid air', fix: 'Replaced micro-switch, adjusted strike plate', parts: ['P-CEN-LID'], tests: 'Rotor will not spin with lid open in 20 consecutive tests' },
  { diag: 'Objective lens de-centred', root: 'Dropped during a student session', fix: 'Re-seated and collimated the 40× objective', parts: ['P-MIC-OBJ'], tests: 'Resolving power verified on a test slide; parfocality across all objectives' },
  { diag: 'Lamp module failed', root: 'End of filament life', fix: 'Replaced lamp module and reset hours counter', parts: ['P-MIC-LAMP'], tests: 'Correct illumination at all settings; 30-min run without flicker' },
  { diag: 'Perished cuff bladder', root: 'Elastic degradation from age and disinfectant', fix: 'Replaced cuff and tested the valve', parts: ['P-BP-CUFF'], tests: 'Holds 250 mmHg for 60 s with <2 mmHg loss' },
  { diag: 'Steam leak at door gasket', root: 'Gasket compressed and torn at the hinge side', fix: 'Replaced gasket, realigned door', parts: ['P-AUT-GSK'], tests: 'Bowie-Dick and vacuum-hold test passed; 134 °C for 3.5 min confirmed with a calibrated probe' },
  { diag: 'Faulty solenoid valve keeping the chamber dry', root: 'Valve seized with limescale from hard feed water', fix: 'Replaced solenoid, descaled reservoir, scheduled water test', parts: ['P-AUT-SOL'], tests: 'Fill, heat, exhaust and dry phases correct; cycle time within spec' },
  { diag: 'Occlusion threshold misconfigured', root: 'Service menu altered during a previous firmware update', fix: 'Restored the occlusion preset and ran the pump self-test', parts: [], tests: 'Alarm triggers at the specified occlusion only; flow rate verified gravimetrically' },
  { diag: 'Pump mechanism wear causing flow drift', root: 'High cumulative hours in simulation teaching', fix: 'Replaced pump mechanism, recalibrated across rates', parts: ['P-INF-PMP'], tests: 'Gravimetric check at 1/5/25/100 mL/h within ±2 %; occlusion and air alarms verified', cal: true },
  { diag: 'Charging circuit failure', root: 'Failed capacitor on the charger board', fix: 'Repaired charging circuit, replaced fuse, verified insulation', parts: ['P-GEN-FUSE'], tests: 'Charges to full in 3 h; earth leakage 42 µA and patient-leakage within IEC limits' },
  { diag: 'Battery pack flagged expired by firmware', root: 'Expired internal battery RTC date in the pack', fix: 'Replaced AED battery and updated firmware', parts: ['P-DEF-BAT'], tests: 'Daily self-test passes; shock energy delivered into test load within 10 %' },
  { diag: 'Intermittent probe connector', root: 'Worn connector contacts from insertion wear', fix: 'Replaced probe connector, cleaned socket', parts: ['P-ULT-PROBE'], tests: 'Uniform echo across all elements; no dropout after 200 insertions' },
  { diag: 'Temperature controller PID drift', root: 'Aging sensor and controller calibration drift', fix: 'Replaced PT100 sensor, retuned PID loop', parts: [], tests: 'Holds 37.0 °C ±0.2 °C over 24 h logging', cal: true },
  { diag: 'No diagnosed hardware fault', root: 'Operator technique: reusable electrodes were dry and the skin was not prepared', fix: 'Cleaned electrode holders, demonstrated correct preparation with the instructor', parts: [], tests: 'Reproduced acceptable trace with the department technique after instruction' },
];

/* ------------------------------------------------------------------ engine -- */

const now = new Date();

export async function seedIfEmpty(db, { demoPassword = '' } = {}) {
  if ((db.value('SELECT COUNT(*) FROM users') ?? 0) > 0) return { seeded: false };
  return seed(db, { demoPassword });
}

export async function seed(db, { demoPassword = '', force = false } = {}) {
  migrate(db);
  if (!force && (db.value('SELECT COUNT(*) FROM equipment') ?? 0) > 0 && (db.value("SELECT COUNT(*) FROM users") > 0)) {
    const existing = db.value("SELECT COUNT(*) FROM users WHERE is_active = 1");
    if (existing > 0 && !force) throw new Error('Database already contains users. Use `npm run reset` for a clean demo rebuild.');
  }

  const password = demoPassword && demoPassword.length >= 10 ? demoPassword : generatePassword(4);
  const generated = !demoPassword;
  const hashCache = new Map();
  const hashFor = async (pw) => {
    if (!hashCache.has(pw)) hashCache.set(pw, await hashPassword(pw));
    return hashCache.get(pw);
  };
  const pw = await hashFor(password);

  const counts = { users: 0, equipment: 0, faults: 0, repairs: 0, maintenance: 0, notifications: 0, schedules: 0 };

  return db.tx(() => {
    /* ---- configuration rows ---- */
    const settingsAt = iso(now);
    const settings = {
      department_name: ['Biomedical Engineering Department', 'string'],
      institution_name: ['St Hospital School of Health Sciences (fictional demo)', 'string'],
      report_footer: ['Fictional demonstration data — not a record of real equipment or real maintenance.', 'string'],
      currency: ['USD', 'string'],
      sla_hours: [JSON.stringify(DEFAULT_SLA_HOURS), 'json'],
      due_soon_days: ['14', 'int'],
      maintenance_reminder_days: ['7', 'int'],
      qr_label_include_location: ['1', 'bool'],
      require_verification_before_close: ['1', 'bool'],
      demo_data_installed: ['1', 'bool'],
    };
    for (const [key, [value, type]] of Object.entries(settings)) {
      db.run(`INSERT INTO app_settings (key, value, value_type, description, updated_at) VALUES (?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [key, value, type, 'Seeded demo configuration', settingsAt]);
    }

    for (const c of CATEGORIES) {
      db.run('INSERT INTO equipment_categories (code, name, description, is_active, created_at) VALUES (?,?,?,1,?)',
        [c.code, c.name, c.description, settingsAt]);
    }
    for (const l of LOCATIONS) {
      db.run('INSERT INTO locations (code, name, building, floor, room, is_active, created_at) VALUES (?,?,?,?,?,1,?)',
        [l.code, l.name, l.building, l.floor, l.room, settingsAt]);
    }
    for (const f of FAULT_CATEGORIES) {
      db.run('INSERT INTO fault_categories (code, name, description, default_severity, is_active, created_at) VALUES (?,?,?,?,1,?)',
        [f.code, f.name, f.description, f.default, settingsAt]);
    }
    for (const p of PARTS) {
      db.run('INSERT INTO replacement_parts (code, name, category, unit, unit_cost, in_stock, is_active, created_at) VALUES (?,?,?,?,?,?,1,?)',
        [p[0], p[1], p[2], 'pcs', p[3], int(0, 14), settingsAt]);
    }

    /* ---- users ---- */
    const roleIds = new Map(db.all('SELECT id, code FROM roles').map((r) => [r.code, r.id]));
    const userIds = [];
    for (const p of PEOPLE) {
      // must_change_password is left 0 for the demo fleet so a reviewer is not bounced through
      // a password change on first look. Accounts created through the API default to 1.
      const { lastInsertRowid } = db.run(
        `INSERT INTO users (employee_id, full_name, email, phone, job_title, department, password_hash, role_id,
                            is_active, must_change_password, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,NULL)`,
        [p.employee_id, p.full_name, p.email.toLowerCase(), `+1 555 0${int(10, 99)} ${int(1000, 9999)}`,
          p.job_title, p.department, pw, roleIds.get(p.role), 0, iso(daysAgo(int(150, 420)))],
      );
      userIds.push({ id: lastInsertRowid, ...p });
      counts.users += 1;
    }
    const byRole = (code) => userIds.filter((u) => u.role === code);
    const admins = byRole('admin');
    const techs = byRole('technician');
    const reporters = byRole('reporter');

    const catIds = new Map(db.all('SELECT id, code FROM equipment_categories').map((r) => [r.code, r.id]));
    const locIds = new Map(db.all('SELECT id, code FROM locations').map((r) => [r.code, r.id]));
    const faultCatIds = new Map(db.all('SELECT id, code FROM fault_categories').map((r) => [r.code, r.id]));
    const partsByCode = new Map(db.all('SELECT * FROM replacement_parts').map((r) => [r.code, r]));

    /* ---- equipment ---- */
    const fleet = [];
    for (const [catCode, name, manufacturer, model, criticality, count] of FLEET) {
      for (let i = 1; i <= count; i += 1) {
        const categoryCode = catCode;
        const seq = nextSequence(db, `asset:${categoryCode}`);
        const ageDays = int(90, 2900);
        const acquiredOn = dateOnly(daysAgo(ageDays));
        const warrantyDays = int(365, 1460);
        const interval = pick([30, 90, 180, 180, 365, 365]);
        // Spread the fleet across the three traffic-light states on purpose, so the
        // dashboard, the due board and the filters each have something to show.
        const hasPm = chance(0.82);
        const health = rnd();
        const lastPmDays = !hasPm
          ? int(30, 400)
          : health < 0.55
            ? int(3, Math.max(4, Math.floor(interval * 0.7)))            // 🟢 up to date
            : health < 0.75
              ? Math.max(1, interval - int(0, Math.min(12, interval - 1))) // 🟡 due soon
              : interval + int(4, 150);                                    // 🔴 overdue
        const lastPmOn = hasPm ? dateOnly(daysAgo(lastPmDays)) : null;
        const nextPmOn = hasPm ? dateOnly(new Date(Date.parse(lastPmOn) + interval * 86_400_000)) : null;
        const serial = `${manufacturer.slice(0, 2).toUpperCase()}${int(100000, 999999)}${String.fromCharCode(65 + int(0, 25))}`;
        const unitName = count > 1 ? `${name} #${String(i).padStart(2, '0')}` : name;
        const tech = pick(techs);
        const locationId = pick([...locIds.values()]);
        const { lastInsertRowid } = db.run(
          `INSERT INTO equipment (asset_tag, name, category_id, manufacturer, model, serial_number, department,
              location_id, custodian_user_id, custodian_note, acquired_on, warranty_provider, warranty_expires_on,
              status, criticality, notes, is_active, maintenance_interval_days, last_maintenance_on, next_maintenance_on,
              responsible_technician_id, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'operational',?,?,1,?,?,?,?,?,?)`,
          [assetTag(categoryCode, seq), unitName, catIds.get(catCode), manufacturer, model, serial,
            pick(['Biomedical Engineering', 'Physiology', 'Clinical Skills', 'Central Sterile Services']),
            locationId, chance(0.55) ? pick(reporters).id : null, chance(0.4) ? 'Held by the teaching lab supervisor' : null,
            acquiredOn, chance(0.6) ? `${manufacturer} Regional Service` : null,
            dateOnly(new Date(Date.parse(acquiredOn) + warrantyDays * 86_400_000)),
            criticality,
            chance(0.35) ? pick(['Shared with the physiology teaching team.', 'Do not move without technician approval.', 'Spare unit available in the store.', 'Used for OSCE assessments.']) : null,
            hasPm ? interval : null, lastPmOn, nextPmOn, tech.id, iso(daysAgo(ageDays - 5)), admins[0].id],
        );
        db.run(`INSERT INTO equipment_status_history (equipment_id, from_status, to_status, reason, changed_by, changed_at)
                VALUES (?, NULL, 'operational', 'Record created during demo data installation', ?, ?)`, [lastInsertRowid, admins[0].id, iso(daysAgo(ageDays - 5))]);
        fleet.push({ id: lastInsertRowid, tag: db.value('SELECT asset_tag FROM equipment WHERE id = ?', [lastInsertRowid]),
          cat: categoryCode, name: unitName, criticality, acquiredOn, interval, lastPmOn, nextPmOn,
          techId: tech.id, locationId });
        counts.equipment += 1;
      }
    }
    /* ---- PM schedules + records ---- */
    const scheduleTemplates = {
      ECG: ['Annual full service', ['Clean internals and fan', 'Verify lead detection', 'Print test pattern', 'Electrical safety test']],
      MON: ['Half-yearly monitor check', ['Battery capacity check', 'Alarm volume and priority test', 'Spo2/NIBP verification', 'Electrical safety test']],
      CEN: ['Quarterly centrifuge inspection', ['Rotor condition and balance', 'Lid interlock test', 'Belt tension', 'Speed verification']],
      MIC: ['Annual optics service', ['Clean optics', 'Lamp hours check', 'Stage and focus lubrication', 'Köhler alignment']],
      BP: ['Quarterly BP verification', ['Leak test', 'Manometer comparison', 'Cuff condition']],
      AUT: ['Monthly seal and safety check', ['Gasket condition', 'Pressure relief test', 'Vacuum decay test', 'Cycle chart review'], 'Annual pressure vessel inspection', 365],
      INF: ['Quarterly pump verification', ['Flow rate gravimetric test', 'Occlusion pressure test', 'Alarm test', 'Battery runtime']],
      DEF: ['Monthly readiness check', ['Self-test pass', 'Energy delivery verification', 'Pads/battery expiry']],
      ULT: ['Annual imaging QA', ['Probe element check', 'Image uniformity', 'Safety label review']],
      INC: ['Quarterly incubator check', ['Temperature log review', 'CO2 accuracy', 'Over-temperature alarm test']],
      SPA: ['Quarterly suction test', ['Vacuum level', 'Canister seals', 'Overflow protection']],
      SCO: ['Annual light check', ['Illuminance measurement', 'Arm friction', 'Colour temperature']],
    };

    for (const eq of fleet) {
      if (!eq.nextPmOn) continue;
      const tpl = scheduleTemplates[eq.cat] ?? scheduleTemplates.MIC;
      const [title, items] = tpl;
      const { lastInsertRowid: scheduleId } = db.run(
        `INSERT INTO maintenance_schedules (equipment_id, title, interval_days, responsible_technician_id, next_due_on, last_done_on, is_active, notes, created_at, created_by)
         VALUES (?,?,?,?,?,?,1,?,?,?)`,
        [eq.id, title, eq.interval, eq.techId, eq.nextPmOn, eq.lastPmOn, 'Generated from the demo fleet profile.', iso(daysAgo(int(200, 700))), admins[0].id],
      );
      items.forEach((label, idx) => db.run(
        'INSERT INTO maintenance_checklist_items (schedule_id, label, requires_evidence, position) VALUES (?,?,?,?)',
        [scheduleId, label, idx === items.length - 1 ? 1 : 0, idx],
      ));
      counts.schedules += 1;

      const occurrences = Math.max(0, Math.min(4, Math.floor((Date.now() - Date.parse(eq.acquiredOn)) / (eq.interval * 86_400_000))));
      const checklistItems = db.all('SELECT * FROM maintenance_checklist_items WHERE schedule_id = ? ORDER BY position', [scheduleId]);
      for (let n = occurrences; n >= 1; n -= 1) {
        const dueOn = dateOnly(new Date(Date.parse(eq.lastPmOn) - (n - 1) * eq.interval * 86_400_000));
        const late = chance(0.25) ? int(2, 40) : 0;
        const performedOn = dateOnly(new Date(Date.parse(dueOn) + late * 86_400_000));
        if (Date.parse(performedOn) > Date.now()) continue;
        const failedIndex = chance(0.12) ? int(0, checklistItems.length - 1) : -1;
        const refYear = performedOn.slice(0, 4);
        const pmRef = reference('PM', refYear, nextSequence(db, `pm:${refYear}`));
        const tech = chance(0.75) ? pick(techs) : admins[1] ?? admins[0];
        const { lastInsertRowid: recordId } = db.run(
          `INSERT INTO maintenance_records (reference, equipment_id, schedule_id, performed_by, performed_on, started_at, completed_at,
              duration_minutes, findings, actions_taken, condition_found, due_on, days_late, next_due_on, downtime_minutes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [pmRef, eq.id, scheduleId, tech.id, performedOn,
            `${performedOn}T0${int(8, 9)}:00:00Z`, `${performedOn}T1${int(0, 4)}:${String(int(10, 59)).padStart(2, '0')}:00Z`,
            int(25, 180),
            failedIndex >= 0 ? 'One checklist item could not be passed at this visit.' : 'All checks within specification.',
            failedIndex >= 0 ? 'Item referred for technical assessment; a fault report was raised separately.' : 'Consumables renewed, unit returned to the teaching area.',
            failedIndex >= 0 ? 'needs_attention' : chance(0.15) ? 'pass_with_notes' : 'pass',
            dueOn, late, dateOnly(new Date(Date.parse(performedOn) + eq.interval * 86_400_000)), chance(0.4) ? int(20, 180) : 0,
            `${performedOn}T17:00:00Z`],
        );
        checklistItems.forEach((item, idx) => db.run(
          'INSERT INTO maintenance_record_checklist (record_id, item_id, label, outcome, note) VALUES (?,?,?,?,?)',
          [recordId, item.id, item.label, idx === failedIndex ? 'fail' : chance(0.06) ? 'na' : 'pass',
            idx === failedIndex ? 'Requires follow-up by a technician.' : null],
        ));
        counts.maintenance += 1;
      }
    }

    /* ---- faults, workflow history, repairs ---- */
    const faultCount = 52;
    for (let i = 0; i < faultCount; i += 1) {
      const eq = pick(fleet);
      const templates = FAULT_TEMPLATES[eq.cat] ?? FAULT_TEMPLATES.OTH;
      const [title, catCode, description] = pick(templates);

      // A demo fleet needs live work in it: about a third of the reports are deliberately
      // left inside the workflow so the work queue, the KPIs and the notifications have content.
      const live = chance(0.34);
      const ageDays = live ? int(0, 26) : int(21, 600);
      const createdAt = daysAgo(ageDays, int(0, 20));
      const year = createdAt.getUTCFullYear();
      const ref = reference('FLT', year, nextSequence(db, `fault:${year}`));
      const reporter = pick(reporters);
      const stage = live
        ? pick(['reported', 'reported', 'assigned', 'acknowledged', 'under_inspection',
            'under_repair', 'under_repair', 'awaiting_parts'])
        : (chance(0.82) ? 'closed' : pick(['verified', 'repaired']));
      const severity = live && chance(0.28)
        ? 'critical'
        : (chance(0.5) ? pick(['low', 'medium', 'high']) : sevWeighted());
      const dueAt = iso(new Date(createdAt.getTime() + (DEFAULT_SLA_HOURS[severity] ?? 24) * 3_600_000));

      const stagesUpTo = ['reported', 'assigned', 'acknowledged', 'under_inspection', 'under_repair',
        'awaiting_parts', 'repaired', 'verified', 'closed'];
      const endIndex = Math.max(0, stagesUpTo.indexOf(stage));
      const path = stagesUpTo.slice(0, endIndex + 1);
      const resolution = pick(RESOLUTIONS);
      const canHaveRepair = endIndex >= stagesUpTo.indexOf('repaired');
      const clampPast = (d) => (d.getTime() > now.getTime() ? new Date(now.getTime() - int(1, 40) * 3_600_000) : d);

      const assignedAt = path.includes('assigned') ? clampPast(new Date(createdAt.getTime() + int(1, 30) * 3_600_000)) : null;
      const acknowledgedAt = path.includes('acknowledged') && assignedAt
        ? clampPast(new Date(assignedAt.getTime() + int(1, 20) * 3_600_000)) : null;
      const repairedAt = canHaveRepair ? clampPast(new Date((assignedAt ?? createdAt).getTime() + int(1, 12) * 86_400_000)) : null;
      const verifiedAt = path.includes('verified') && repairedAt ? clampPast(new Date(repairedAt.getTime() + int(1, 4) * 86_400_000)) : null;
      const closedAt = path.includes('closed')
        ? clampPast(new Date((verifiedAt ?? repairedAt ?? createdAt).getTime() + int(1, 3) * 86_400_000)) : null;
      // Anything past "assigned" has an owner, so the technician queues are populated.
      const technician = path.length > 1 ? pick(techs) : (chance(0.7) ? pick(techs) : null);

      const { lastInsertRowid: faultId } = db.run(
        `INSERT INTO fault_reports (reference, equipment_id, reported_by, on_behalf_of, category_id, location_id,
            title, description, severity, observed_at, status, assigned_to, assigned_by, assigned_at, due_at,
            acknowledged_at, repaired_at, verified_by, verified_at, closed_at, diagnosis_confirmed, resolution_note,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ref, eq.id, reporter.id,
          chance(0.3) ? pick(['Student group Y2-A', 'Week 6 practical class', 'OSCE station 3', 'Clinic demo']) : null,
          faultCatIds.get(catCode) ?? faultCatIds.get('OTH'), eq.locationId, title, description, severity,
          iso(createdAt), stage, technician?.id ?? null, assignedAt ? admins[0].id : null,
          assignedAt ? iso(assignedAt) : null, dueAt,
          acknowledgedAt ? iso(acknowledgedAt) : null,
          repairedAt ? iso(repairedAt) : null,
          verifiedAt ? admins[0].id : null,
          verifiedAt ? iso(verifiedAt) : null,
          closedAt ? iso(closedAt) : null,
          canHaveRepair ? 1 : 0,
          canHaveRepair && chance(0.5) ? `Resolved: ${resolution.fix}.` : null,
          iso(createdAt), iso(closedAt ?? repairedAt ?? createdAt)],
      );
      counts.faults += 1;

      // Status history following the same path, each step attributed.
      let previous = null;
      let clockAt = new Date(createdAt);
      for (const s of path) {
        const actor = s === 'reported' ? reporter : (technician ?? admins[0]);
        if (s !== 'reported') clockAt = new Date(clockAt.getTime() + int(2, 60) * 3_600_000);
        if (clockAt > now) clockAt = new Date(now.getTime() - 600_000);
        db.run(
          `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
           VALUES (?,?,?,?,?,?,?)`,
          [faultId, previous, s, HISTORY_COMMENT[s]?.(reporter, technician, resolution) ?? null,
            s === 'reported' || s === 'assigned' ? 1 : 0, actor.id, iso(clockAt)],
        );
        previous = s;
      }

      // Equipment status + the status trail that downtime is measured from.
      if (path.length > 0) {
        const equipmentStatusAt = (s) => FAULT_TO_EQUIPMENT_STATUS[s] ?? 'operational';
        const steps = path.map((s) => equipmentStatusAt(s));
        let lastStatus = null;
        let t = new Date(createdAt);
        for (let k = 0; k < steps.length; k += 1) {
          if (steps[k] === lastStatus) continue;
          lastStatus = steps[k];
          t = new Date(Math.min(t.getTime() + int(3, 50) * 3_600_000, now.getTime() - 60_000));
          db.run(
            `INSERT INTO equipment_status_history (equipment_id, from_status, to_status, reason, fault_id, changed_by, changed_at)
             VALUES (?,?,?,?,?,?,?)`,
            [eq.id, k === 0 ? 'operational' : steps[k - 1] ?? 'operational', steps[k],
              `Fault ${ref} ${path[k] ? `→ ${STATUS_META[equipmentStatusAt(path[k])].label.toLowerCase()}` : ''}`,
              faultId, (technician ?? reporter).id, iso(t)],
          );
        }
        const isOpen = OPEN_FAULT_STATUSES.includes(stage);
        const currentStatus = db.value('SELECT status FROM equipment WHERE id = ?', [eq.id]);
        const wanted = isOpen ? equipmentStatusAt(stage) : 'operational';
        if (currentStatus !== wanted) {
          db.run('UPDATE equipment SET status = ? WHERE id = ?', [wanted, eq.id]);
        }
      }

      /* repair record + parts */
      if (canHaveRepair) {
        const rRef = reference('RPR', (repairedAt ?? createdAt).getUTCFullYear(), nextSequence(db, `repair:${(repairedAt ?? createdAt).getUTCFullYear()}`));
        const labour = chance(0.35) ? int(40, 180) : 0;
        const other = chance(0.2) ? int(10, 60) : 0;
        const tech = technician ?? pick(techs);
        const { lastInsertRowid: repairId } = db.run(
          `INSERT INTO repair_records (reference, fault_id, equipment_id, technician_id, diagnosis, root_cause,
              troubleshooting, repair_actions, parts_replaced_summary, test_results, calibration_performed, calibration_details,
              parts_cost, labour_cost, other_cost, total_cost, currency, safety_check_confirmed, safe_to_return_to_service,
              date_repaired, notes, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)`,
          [rRef, faultId, eq.id, tech.id, resolution.diag, resolution.root,
            'Visual inspection, mains check, functional test with a known-good reference, then targeted measurement of the suspect stage.',
            resolution.fix, resolution.parts.length ? resolution.parts.map((c) => `1 × ${partsByCode.get(c).name}`).join('; ') : 'No parts consumed',
            resolution.tests, resolution.cal ? 1 : 0, resolution.cal ? 'Verified against a traceable reference; deviation within tolerance; label updated.' : null,
            resolution.parts.reduce((n, c) => n + (partsByCode.get(c)?.unit_cost ?? 0), 0), labour, other,
            resolution.parts.reduce((n, c) => n + (partsByCode.get(c)?.unit_cost ?? 0), 0) + labour + other,
            'USD', dateOnly(repairedAt ?? createdAt),
            chance(0.3) ? 'Advised the user on correct handling to prevent recurrence.' : null,
            iso(repairedAt ?? createdAt), tech.id],
        );
        for (const code of resolution.parts) {
          const part = partsByCode.get(code);
          const qty = 1;
          db.run(
            `INSERT INTO repair_parts (repair_id, part_id, part_name, part_number, quantity, unit_cost, line_cost, recovered)
             VALUES (?,?,?,?,?,?,?,?)`,
            [repairId, part.id, part.name, part.code, qty, part.unit_cost, Math.round(part.unit_cost * qty * 100) / 100, chance(0.3) ? 1 : 0],
          );
        }
        counts.repairs += 1;
        auditSeed(db, tech.id, tech.role, 'repair.create', 'repair_record', repairId, rRef,
          `${ref}: ${resolution.diag.slice(0, 70)}`, iso(repairedAt ?? createdAt));
      }

      // A handful of reports get evidence notes (no binary files in demo data).
      if (chance(0.2)) {
        db.run(
          `INSERT INTO fault_status_history (fault_id, from_status, to_status, comment, auto_action, changed_by, changed_at)
           VALUES (?,?,?,?,0,?,?)`,
          [faultId, stage, stage, `Follow-up from ${reporter.full_name.split(' ')[0]}: ${pick(['still reproducible when the room is warm', 'happens most often after the lunch session', 'happens with another set of accessories too', 'stopped when another user moved the cable'])}`, reporter.id,
            iso(new Date(createdAt.getTime() + int(2, 50) * 3_600_000))],
        );
      }

      if (i % 7 === 0) {
        auditSeed(db, reporter.id, reporter.role, 'fault.create', 'fault_report', faultId, ref,
          `${severity.toUpperCase()} fault reported on ${eq.tag}`, iso(createdAt));
      }
    }

    /* ---- notifications (recent, mostly unread) ---- */
    const recent = db.all(
      `SELECT f.id, f.reference, f.severity, f.status, f.created_at, e.asset_tag, e.name, e.id AS eq_id, f.assigned_to
         FROM fault_reports f JOIN equipment e ON e.id = f.equipment_id
        ORDER BY datetime(f.created_at) DESC LIMIT 14`,
    );
    for (const f of recent) {
      const targets = new Set([...admins.map((a) => a.id), ...techs.map((t) => t.id), ...(f.assigned_to ? [f.assigned_to] : [])]);
      for (const userId of targets) {
        const type = f.severity === 'critical' && userId !== f.assigned_to ? 'fault_critical' : 'fault_status_changed';
        const { lastInsertRowid: nid } = db.run(
          `INSERT INTO notifications (user_id, type, title, body, link, severity, entity_type, entity_id, is_read, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [userId, type,
            f.severity === 'critical' ? `CRITICAL fault ${f.reference}` : `Fault ${f.reference} is ${f.status.replace(/_/g, ' ')}`,
            `${f.name} (${f.asset_tag})`, `/faults/${f.id}`, f.severity === 'critical' ? 'critical' : 'info',
            'fault_report', f.id, chance(0.4) ? 1 : 0, f.created_at],
        );
        db.run(`INSERT INTO notification_deliveries (notification_id, channel, target, status, detail, created_at)
                VALUES (?,'in_app',?, 'sent', 'Delivered to the in-app centre', ?)`, [nid, `user:${userId}`, f.created_at]);
        for (const ch of ['email', 'sms', 'push']) {
          db.run(`INSERT INTO notification_deliveries (notification_id, channel, target, status, detail, created_at)
                  VALUES (?,?,'demo',  'skipped', 'Channel not enabled on this deployment', ?)`, [nid, ch, f.created_at]);
        }
        counts.notifications += 1;
      }
    }

    /* ---- PM reminders for the due board ---- */
    const dueItems = db.all(
      `SELECT e.id, e.asset_tag, e.name, e.next_maintenance_on, e.responsible_technician_id,
              CAST(julianday(e.next_maintenance_on) - julianday('now') AS INTEGER) AS d
         FROM equipment e WHERE e.next_maintenance_on IS NOT NULL
           AND julianday(e.next_maintenance_on) - julianday('now') <= 14 LIMIT 12`,
    );
    for (const e of dueItems) {
      for (const uid of [e.responsible_technician_id, ...admins.map((a) => a.id)].filter(Boolean)) {
        const { lastInsertRowid: nid } = db.run(
          `INSERT INTO notifications (user_id, type, title, body, link, severity, entity_type, entity_id, is_read, created_at)
           VALUES (?,?,?,?,?,?,?,?,0,?)`,
          [uid, e.d < 0 ? 'maintenance_overdue' : 'maintenance_due',
            e.d < 0 ? `Maintenance overdue: ${e.asset_tag}` : `Maintenance due soon: ${e.asset_tag}`,
            `${e.name} was due ${e.next_maintenance_on} (${Math.abs(e.d)} day(s) ${e.d < 0 ? 'overdue' : 'from now'}).`,
            `/equipment/${e.id}`, e.d < 0 ? 'warning' : 'info', 'equipment', e.id, iso(daysAgo(int(0, 5)))],
        );
        db.run(`INSERT INTO notification_deliveries (notification_id, channel, target, status, detail, created_at)
                VALUES (?,'in_app',?,'sent','Delivered to the in-app centre',?)`, [nid, `user:${uid}`, iso(daysAgo(1))]);
        counts.notifications += 1;
      }
    }

    auditSeed(db, admins[0].id, 'admin', 'system.seed', 'system', null, 'demo',
      `Installed fictional demo data: ${counts.equipment} items, ${counts.faults} fault reports, ${counts.repairs} repairs, ${counts.maintenance} PM records`,
      iso(now));

    return finish(counts, password, generated, admins, techs, reporters);
  });

  function finish(c, demoPw, wasGenerated, adminList, techList, reporterList) {
    const file = path.join(config.paths.data, 'demo-credentials.txt');
    const lines = [
      '# BEM-FRS demo accounts — FICTIONAL data, generated automatically.',
      `# password: ${demoPw}`,
      ...adminList.map((u) => `admin       ${u.email}`),
      ...techList.map((u) => `technician  ${u.email}`),
      ...reporterList.map((u) => `reporter    ${u.email}`),
    ].join('\n') + '\n';
    try { fs.writeFileSync(file, lines, { mode: 0o600 }); } catch { /* non-fatal */ }
    return {
      seeded: true,
      counts: c,
      password: demoPw,
      passwordShown: wasGenerated,
      credentialsFile: file,
      accounts: [
        { role: 'Administrator', email: adminList[0].email, password: demoPw },
        { role: 'Technician', email: techList[0].email, password: demoPw },
        { role: 'Reporter', email: reporterList[0].email, password: demoPw },
      ],
    };
  }
}

const HISTORY_COMMENT = {
  reported: (r) => `Reported by ${r.full_name}`,
  assigned: (_r, t) => (t ? `Assigned to ${t.full_name}` : 'Awaiting assignment'),
  acknowledged: (_r, t) => (t ? `${t.full_name} acknowledged the request` : 'Acknowledged'),
  under_inspection: () => 'Bench inspection started; power-up and functional checks underway',
  under_repair: (_r, _t, res) => `Repair started — ${res.diag.toLowerCase()}`,
  awaiting_parts: () => 'Replacement part ordered; unit off the teaching floor until it arrives',
  repaired: (_r, _t, res) => `Work complete. ${res.tests}`,
  verified: () => 'Function verified with the reporting lab; equipment returned to service',
  closed: () => 'Closed and recorded in the equipment history',
};

function auditSeed(db, actorId, role, action, entityType, entityId, entityRef, summary, at) {
  db.run(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, entity_ref, summary, ip, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [actorId, role, action, entityType, entityId, entityRef, summary, '127.0.0.1', 'demo-seed', at],
  );
}

/** `npm run seed` entry point. */
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const { getDb } = await import('../lib/db.js');
  const db = getDb();
  const result = await seed(db, { demoPassword: config.demo.password, force: process.env.SEED_FORCE === '1' });
  console.log('Demo data installed (FICTIONAL):', JSON.stringify(result.counts));
  console.log(`Sign in: ${result.accounts.map((a) => a.email).join(', ')}`);
  console.log(`Password: ${result.password}${result.passwordShown ? '  (generated — not stored anywhere except the credentials file)' : ''}`);
  if (result.credentialsFile) console.log(`Credentials file: ${result.credentialsFile}`);
  db.close();
}

export { CATEGORIES, LOCATIONS, FAULT_CATEGORIES, PARTS };
