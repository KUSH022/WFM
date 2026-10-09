# KP WFM – Workforce Management Rules Audit (v1.1)

Scope: review of the whole application against WFM scheduling rules. No redesign; all v1.0 functionality and the
seeded KP Retail Group demo data are preserved. Rules live in **one** place (`server/rules.js`) and are applied to
every entry point: UI create/edit, drag & drop, open-shift assignment, employee pickup and inbound API import.

## 1. Findings and corrections

| # | Rule | v1.0 behaviour (violation) | v1.1 correction | Where |
|---|---|---|---|---|
| 1 | Open shifts belong to a specific date | Dragging an open shift to another day moved its date | Date is locked. Drag to another day is rejected in UI; API returns 409 *"this Monday shift can only be assigned on Monday"*. New `POST /shifts/:id/assign` rejects a different `date` | `rules.assertIntegrity`, `handlers.assignOpenShift`, `Scheduling.jsx move()` |
| 2 | Employee must be active | Checked only `status` | Checks `status` **and** `employmentStatus` (On Leave / Terminated). Deactivated employees' future shifts are released to open shifts | `rules.validateShift`, `handlers.releaseFutureShifts` |
| 3 | Employee must belong to the location | Not checked | Enforced (422) | `rules.validateShift` |
| 4 | Employee must belong to the department | Not checked; assigning overwrote the shift department with the employee's | Enforced (configurable); shift department never overwritten | `rules.validateShift`, `handlers.finalizeShift` |
| 5 | Required skills | Not supported | `requiredSkills` on shifts, `skills` on employees (defaults by job role / job profile); missing skills block assignment | `rules.validateShift`, `Employees.jsx`, `Scheduling.jsx` |
| 6 | Overlap validation | Same-day overlap only | Overlap across days incl. overnight shifts | `rules.span/validateShift` |
| 7 | Duplicate shifts | Not checked | Identical employee shift blocked; identical open shift (location/date/time/dept/job) blocked | `rules.validateShift` |
| 8 | Daily hour limit | Not enforced | `maxDailyHours` (default 10) + `maxShiftHours` (default 12) | `rules.validateShift` |
| 9 | Weekly hour limit | UI showed OT only | `maxWeeklyHours` (default 48) blocks; > overtime threshold (40) warns | `rules.validateShift` |
| 10 | Rest period | Not checked | `minRestHours` (default 10) between shifts on different days | `rules.validateShift` |
| 11 | Published schedule controls | Published schedules editable directly | Edit Mode required (423 otherwise). `POST /schedules/edit-mode`; publish closes Edit Mode; UI lock banner & read-only modal | `rules.assertEditable`, `handlers.setEditMode`, `Scheduling.jsx` |
| 12 | Track modifications | Generic audit text | Field-level *before → after* details for shifts, employees, locations, budgets, timecards, settings | `handlers.diff` |
| 13 | Availability validation | Visual hint only | Blocks assignment on unavailable weekday and on **approved** time off; pending time off warns | `rules.validateShift` |
| 14 | Labor budget validation | Not shown in scheduling | Warning returned on every change + over-budget banner and utilization in Scheduling | `rules.validateShift`, `handlers.listSchedules`, `Scheduling.jsx` |
| 15 | Schedule integrity | Date, location, department and job role could change on edit | Locked on every existing shift (409). UI fields disabled for existing shifts | `rules.assertIntegrity`, `Scheduling.jsx ShiftModal` |
| 16 | Copy schedule | Copied inactive / unavailable assignments | Keeps weekday/location/department/job; invalid assignments converted to open shifts; target must be editable | `handlers.copySchedule` |
| 17 | Open-shift pickup race | Two employees could claim the same shift | Atomic conditional replace (409 for the loser) + all assignment rules | `handlers.claimShift` |
| 18 | Time off approval | No schedule feedback | Approval warns about conflicting scheduled shifts | `handlers.decideTimeoff` |
| 19 | Inactive employee clock-in | Allowed | Blocked | `handlers.punch` |

## 2. Configurable rules (Administration → System Settings)

| Setting | Default | Type |
|---|---|---|
| maxDailyHours | 10 | hard |
| maxWeeklyHours | 48 | hard |
| minRestHours | 10 | hard |
| maxShiftHours | 12 | hard |
| overtimeThresholdWeekly | 40 | warning |
| budgetWarningPct | 100 | warning |
| enforceAvailability / enforceDepartmentMatch / enforceSkills | on | toggle |
| requireEditModeForPublished / preventDuplicateOpenShifts | on | toggle |
| logReadRequests | off | audit |

Defaults are merged at runtime, so databases seeded by v1.0 need no migration.

## 3. API documentation module
* Menu: **Administration → API Documentation** (Administrator).
* Generated from the registered route table (`server/router.js` → `server/apiDocs.js`): new routes appear automatically.
* Per API: endpoint, method, roles, purpose, request payload, response payload, validation rules, example request, example response.
* Inbound (`POST /api/integrations/inbound/<entity>`) and Outbound (`GET /api/integrations/outbound/<entity>`) APIs for
  Employees, Locations, Schedules, Timecards, Forecasts, Labor Budgets, Time Off Requests, Departments, Jobs and Availability.
* API Explorer: path/query/body editors, live call with the session token, status, latency and JSON response, copy cURL.

## 4. Audit logging
| Event | Action / Entity |
|---|---|
| Schedule creation | `CREATE Schedule` (first shift in a week, publish of a new week, copy) |
| Schedule edits | `CREATE/UPDATE/DELETE Shift`, `EDIT_MODE Schedule`, `PUBLISH Schedule` (with changed count) |
| Open shift assignment | `ASSIGN Open Shift` (manager assignment or employee pickup), `UNASSIGN Shift`, `RELEASE Shift` |
| Employee updates | `UPDATE Employee` with field-level changes |
| Location updates | `UPDATE Location` with field-level changes |
| API requests | `API_REQUEST API` – all write calls (+ GET when enabled or from API Explorer) with latency |
| API failures | `API_FAILURE API` – every 4xx/5xx with status and message (incl. failed logins & rule violations) |
| Integrations | `INBOUND / INBOUND_PARTIAL Integration` batch summary + per-record entity events tagged `[Inbound API]` |

## 5. Test checklist (demo data)
1. Manager → Scheduling → KP Downtown Store (published): drag any shift → error *enable Edit Mode*.
2. Enable Edit Mode → drag a Monday open shift onto Tuesday → rejected; onto an employee's Monday cell → assigned or rule error listed.
3. Assign an Optician open shift to a Sales Associate → *department* violation.
4. Create a 08:00–20:00 shift → *daily limit* (10h) violation.
5. Give an employee a 12:00–20:00 shift and a next-day 04:00 shift → *rest period* violation.
6. Add a shift with required skill "Key Holder" for a Sales Associate → *missing skill*.
7. Publish → Edit Mode closes; Admin → Audit Logs shows ASSIGN / UPDATE / PUBLISH / API_REQUEST / API_FAILURE.
8. Admin → API Documentation → `GET integrations/outbound/employees` → Send request.
