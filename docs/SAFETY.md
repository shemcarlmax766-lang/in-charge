# Safety Boundary — what this system never does

The brief was explicit, so this is a first-class requirement, not a disclaimer footer:
**BEM-FRS manages the department's maintenance workflow. It never touches clinical decisions.**
This file states the boundary, every place it is enforced, and the design decisions that exist
only because of it.

## 1. The three prohibitions

| Never | Why it is easy to slip over |
| --- | --- |
| **Diagnose patients** | The system holds equipment + rooms + users — no patient identifier or clinical field exists anywhere in the schema (24 tables, zero patient references). There is nothing to leak. |
| **Diagnose equipment faults** | A maintenance log looks like a diagnosis. Enforced: fault *observations* (reporter) and technician *work records* (diagnosis/root-cause of a fault the technician personally verified) are separate, role-gated concepts; the app itself computes no "cause" — only the transparent rule-based *maintenance priority* of §3, which is clearly labelled. |
| **Certify equipment safety** | “Operational” status + green checkmarks *read* like a certificate. Enforced: the word “safety” is never claimed by the system — only by *people* (the technician's `safe_to_return_to_service` attestation flag on a repair record, with their identity and timestamp on the audit trail). The department's sign-off process stays the source of truth. |

## 2. Standing notices (verbatim from code)

* Every risk payload carries
  `disclaimer: “Decision-support indicator only. It ranks maintenance attention using this
  department's own history; it does not certify that equipment is safe, does not diagnose faults,
  and does not replace inspection by a qualified biomedical engineer.”` (`risk.service.js`).
* The UI repeats it as a pinned `Callout tone="safety"` on the risk board and equipment detail,
  and it is in the print footer of every report: *“Maintenance-risk figures are decision support
  for qualified staff and do not certify equipment safety.”*
* The public QR landing page (`/e/:tag`) shows equipment *status as recorded by staff* — never a
  risk score, never history — because a phone at a bedside is not the place for inference.
* Severity copy steers behaviour rather than pretending to be clinical: `critical` = “Unsafe to
  use or a safety function is lost — stop using it and tell the desk now”; `life_support`
  criticality = “Treated as safety-critical for scheduling; still requires human sign-off for use”.

## 3. The risk model is decision support, and it shows its work

The maintenance-risk score is **rule-based arithmetic over this department's records** — never a
model, never “AI”, and the product refuses to hide it:

* `GET /dashboard/risk/model` returns the exact factors, weights and band boundaries the scorer
  uses (7 factors, raw 0–135 → 0–100, Low/Moderate/High; one escalation rule:
  *life-support/high criticality + (PM overdue OR open critical fault) ⇒ at least High*).
* Every score response enumerates each factor's `contributing[]` lines in plain English
  (“2 open faults incl. 1 critical +14; PM 38 days overdue +20…”), so a technician can disagree
  with a specific factor using data, not vibes.
* Output bands map to **maintenance actions** (shorten interval, plan overhaul, provide backup
  unit) — never to “unsafe to use”. Scheduling language only.

## 4. What the boundary does *not* mean

It is still a clinical-environment-adjacent system, so the serious operational requirements apply:

* Fault reporting **must** be fast and reliable (the 4-hour critical-SLA path, notifications, and
  the state machine that structurally prevents “closed but never repaired” exist because of that).
* Records **must** be attributable (every status change stores who/when/from/to/comment; audit
  rows snapshot the actor's role).
* Availability of *this* system is not a patient-safety control — the department's safety controls
  are its procedures; BEM-FRS is the paperwork that proves they happened.

## 5. Extension rules (for anyone adding features later)

Add only if it: stores workflow facts, computes scheduling arithmetic from them, or routes them
to humans. Reject: any patient/clinical data, any auto-generated technical conclusion, any UI
wording that could be photographed and mistaken for an inspection certificate. The two rules the
department's accountability model needs kept intact: reporters never write official technical
records; non-technicians never claim a diagnosis.
