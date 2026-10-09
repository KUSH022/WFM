/**
 * API documentation generator.
 * GET /api/admin/api-docs walks the *registered* route table at runtime (server/router.js passes it in),
 * so every endpoint that exists is documented automatically. Rich descriptions come from CORE_DOCS
 * (core routes) or from the 5th element of a route tuple (integration routes generate their own docs).
 * Routes without a description still appear with method, path and roles.
 */
const ID = 'string (24-char id)';
const PAGE = { items: '[...]', total: 'number', page: 'number', pages: 'number' };
const WEEK = '2026-10-05';

export const CORE_DOCS = {
    'GET health': { group: 'System', purpose: 'Database connectivity health check.', response: { ok: 'boolean', time: 'ISO datetime' }, exampleResponse: { ok: true, time: '2026-10-08T06:00:00.000Z' } },
    'POST auth/login': {
        group: 'Authentication', purpose: 'Sign in with email/password and receive a JWT (12h).',
        request: { email: 'string *', password: 'string *' }, response: { token: 'JWT', user: '{ _id, email, name, role, employeeId }' },
        rules: ['Email is case-insensitive', 'Disabled accounts receive 403', 'Wrong credentials receive 401 (logged as API_FAILURE)'],
        exampleRequest: { body: { email: 'manager@kpwfm.com', password: 'Manager123' } },
        exampleResponse: { token: 'eyJhbGciOi...', user: { _id: 'usr-manager', email: 'manager@kpwfm.com', name: 'James Anderson', role: 'Manager', employeeId: 'emp-001' } }
    },
    'GET auth/me': { group: 'Authentication', purpose: 'Current user profile and linked employee record.', response: { user: 'object', employee: 'object | null' } },
    'GET meta': {
        group: 'System', purpose: 'Lookup data: locations, employees, departments, job roles, skills, managers and active WFM rules.',
        response: { locations: '[]', employees: '[]', departments: '[string]', jobTitles: '[string]', skills: '[string]', managers: '[]', rules: 'object' }
    },
    'GET dashboard': {
        group: 'Dashboard', purpose: 'Workforce KPIs, staffing overview and trends (personal dashboard for Employees).',
        response: { cards: '{ totalEmployees, activeEmployees, locations, openShifts, pendingTimeOff, attendanceExceptions, scheduledHours, laborCost, laborBudget, budgetUtilization }', staffing: '[]', laborTrend: '[]' }
    },

    'GET employees': {
        group: 'Employees', purpose: 'Search and page employees.', request: { query: { q: 'text', locationId: ID, department: 'string', status: 'Active|Inactive', employmentType: 'string', page: 'number', limit: 'number' } },
        response: PAGE, exampleRequest: { query: { q: 'garcia', page: 1, limit: 5 } }
    },
    'POST employees': {
        group: 'Employees', purpose: 'Create an employee.',
        request: { firstName: 'string *', lastName: 'string *', email: 'string *', locationId: `${ID} *`, department: 'string', jobTitle: 'string', hourlyRate: 'number', employmentType: 'Full-Time|Part-Time|Weekend-Only', managerId: ID, skills: '[string]', availability: '[{ day, available }]' },
        rules: ['firstName, lastName, email, locationId required', 'employeeId must be unique (auto KPxxxx when omitted)', 'hourlyRate > 0', 'Audited as CREATE Employee'],
        exampleRequest: { body: { firstName: 'Alex', lastName: 'Morgan', email: 'alex.morgan@kpretail.com', locationId: 'loc-dtn', department: 'Retail Sales', jobTitle: 'Sales Associate', hourlyRate: 16.5, skills: ['Sales'] } }
    },
    'GET employees/:id': { group: 'Employees', purpose: 'Get one employee (employees can only read their own record).', exampleRequest: { params: { id: 'emp-004' } } },
    'PUT employees/:id': {
        group: 'Employees', purpose: 'Update an employee (partial).', request: { '...': 'any POST field', status: 'Active|Inactive', employmentStatus: 'Active|On Leave|Terminated' },
        rules: ['Field-level changes are written to the audit log (before → after)', 'Inactive / On Leave / Terminated employees have their future shifts released to open shifts'],
        exampleRequest: { params: { id: 'emp-004' }, body: { hourlyRate: 17.25, skills: ['Sales', 'Cash Handling', 'Key Holder'] } }
    },
    'DELETE employees/:id': { group: 'Employees', purpose: 'Deactivate an employee (soft delete).', rules: ['History is preserved', 'Future shifts are released to open shifts'], exampleRequest: { params: { id: 'emp-050' } } },

    'GET locations': { group: 'Locations', purpose: 'List locations with active headcount.' },
    'POST locations': {
        group: 'Locations', purpose: 'Create a location.', request: { name: 'string *', costCenter: 'string *', code: 'string (unique)', region: 'string', operatingHours: 'object', departments: '[{ name, parent }]', weeklyLaborBudget: 'number' },
        rules: ['name and costCenter required', 'code must be unique'], exampleRequest: { body: { name: 'KP Northgate Store', code: 'NRT', costCenter: 'CC-1004', region: 'North Region', weeklyLaborBudget: 9500 } }
    },
    'PUT locations/:id': {
        group: 'Locations', purpose: 'Update a location.', rules: ['Changes are audited field by field', 'weeklyLaborBudget also updates the current week budget'],
        exampleRequest: { params: { id: 'loc-dtn' }, body: { phone: '(555) 777-1000' } }
    },
    'DELETE locations/:id': { group: 'Locations', purpose: 'Delete a location (Administrator).', rules: ['Rejected with 409 while active employees are assigned'] },

    'GET shifts': {
        group: 'Schedules', purpose: 'Shifts for a week (employees see only their own published shifts and posted open shifts).',
        request: { query: { weekStart: 'YYYY-MM-DD Monday', locationId: ID, department: 'string', date: 'YYYY-MM-DD', employeeId: ID } }, exampleRequest: { query: { weekStart: WEEK, locationId: 'loc-dtn' } }
    },
    'POST shifts': {
        group: 'Schedules', purpose: 'Create a shift (assigned or open).',
        request: { locationId: `${ID} *`, date: 'YYYY-MM-DD *', start: 'HH:mm *', end: 'HH:mm *', department: 'string *', jobTitle: 'string *', employeeId: `${ID} | null`, requiredSkills: '[string]', posted: 'boolean', notes: 'string' },
        response: { '...shift': 'object', warnings: '[string] e.g. labor budget / overtime' },
        rules: ['Published schedule requires Edit Mode (423)', 'Employee must be active, in the same location and department', 'Required skills must be present',
            'Availability & approved time off are checked', 'No overlapping or duplicate shifts', 'Daily / weekly hour limits and minimum rest period', 'Max single shift length',
            'Duplicate identical open shifts are blocked', 'Labor budget overrun returns a warning (not an error)', 'Violations return 422 with details[]'],
        exampleRequest: { body: { locationId: 'loc-ctr', date: WEEK, start: '10:00', end: '18:00', department: 'Retail Sales', jobTitle: 'Sales Associate', employeeId: null, posted: true } },
        exampleResponse: { _id: '6f1c...', date: WEEK, start: '10:00', end: '18:00', employeeId: null, hours: 8, published: false, warnings: [] }
    },
    'PUT shifts/:id': {
        group: 'Schedules', purpose: 'Edit a shift: times, employee, required skills, notes.',
        request: { start: 'HH:mm', end: 'HH:mm', employeeId: `${ID} | null`, requiredSkills: '[string]', notes: 'string', posted: 'boolean' },
        rules: ['Schedule integrity: date, locationId, department and jobTitle are locked (409 if changed)', 'All assignment rules re-run when employee, times or skills change', 'Edit Mode required on published schedules', 'Before → after audit trail'],
        exampleRequest: { params: { id: '<shiftId>' }, body: { start: '09:00', end: '17:00' } }
    },
    'POST shifts/:id/assign': {
        group: 'Schedules', purpose: 'Assign an open shift to an employee.',
        request: { employeeId: `${ID} *`, date: 'optional – must equal the open shift date' },
        rules: ['Open shifts belong to their date: a Monday open shift can only be assigned on Monday', 'All assignment rules apply', 'Audited as ASSIGN Open Shift'],
        exampleRequest: { params: { id: '<openShiftId>' }, body: { employeeId: 'emp-005' } }
    },
    'POST shifts/:id/claim': { group: 'Schedules', purpose: 'Employee self-service pickup of a posted open shift.', rules: ['allowShiftPickup must be enabled', 'All assignment rules apply', 'Atomic – only one employee can claim'] },
    'DELETE shifts/:id': { group: 'Schedules', purpose: 'Delete a shift.', rules: ['Edit Mode required on published schedules', 'Audited'] },
    'GET schedules': {
        group: 'Schedules', purpose: 'Schedule status per location for a week, incl. edit mode, cost and labor budget utilization.',
        request: { query: { weekStart: 'YYYY-MM-DD' } }, response: '[{ locationId, status, editMode, locked, shifts, hours, open, cost, budgetAmount, budgetUtilization, overBudget }]', exampleRequest: { query: { weekStart: WEEK } }
    },
    'POST schedules/publish': {
        group: 'Schedules', purpose: 'Publish a location-week (all shifts become visible to employees) and close Edit Mode.',
        request: { locationId: `${ID} *`, weekStart: 'YYYY-MM-DD *' }, exampleRequest: { body: { locationId: 'loc-ctr', weekStart: WEEK } }
    },
    'POST schedules/edit-mode': {
        group: 'Schedules', purpose: 'Enable or disable Edit Mode on a published schedule.',
        request: { locationId: `${ID} *`, weekStart: 'YYYY-MM-DD *', enabled: 'boolean *' }, rules: ['Only published schedules', 'Audited as EDIT_MODE'],
        exampleRequest: { body: { locationId: 'loc-dtn', weekStart: WEEK, enabled: true } }
    },
    'POST schedules/copy': {
        group: 'Schedules', purpose: 'Copy a week of shifts to another week (keeps weekday, location, department, job role).',
        request: { locationId: `${ID} *`, fromWeek: 'Monday *', toWeek: 'Monday *', replace: 'boolean' },
        rules: ['Weeks must be Mondays', 'Target must be editable', 'Assignments failing rule checks (inactive, unavailable, approved time off, department) become open shifts']
    },

    'GET timecards': { group: 'Timecards', purpose: 'Timecards with exceptions (employees see their own).', request: { query: { from: 'date', to: 'date', locationId: ID, employeeId: ID, exceptionsOnly: 'true|false', q: 'name', page: 'number', limit: 'number' } }, response: PAGE },
    'GET timecards/status': { group: 'Timecards', purpose: "Today's timecard and shift for the signed-in employee." },
    'POST timecards/punch': {
        group: 'Timecards', purpose: 'Record a punch.', request: { action: 'in|mealStart|mealEnd|out *', date: 'YYYY-MM-DD', time: 'HH:mm' },
        rules: ['One clock-in per day', 'Meal must end before clock-out', 'Inactive employees cannot clock in'], exampleRequest: { body: { action: 'in', time: '08:01' } }
    },
    'PUT timecards/:id': { group: 'Timecards', purpose: 'Manager correction of punches / resolve exceptions.', request: { clockIn: 'HH:mm', clockOut: 'HH:mm', mealStart: 'HH:mm', mealEnd: 'HH:mm', notes: 'string', resolved: 'boolean' } },

    'GET timeoff': { group: 'Time Off Requests', purpose: 'List requests.', request: { query: { status: 'Pending|Approved|Rejected|Cancelled', type: 'Vacation|Sick|Personal', q: 'name', page: 'number' } }, response: PAGE },
    'POST timeoff': {
        group: 'Time Off Requests', purpose: 'Submit a request.', request: { type: 'Vacation|Sick|Personal *', startDate: 'date *', endDate: 'date *', reason: 'string', employeeId: 'managers only' },
        rules: ['endDate >= startDate', 'No overlap with Pending/Approved requests'], exampleRequest: { body: { type: 'Vacation', startDate: '2026-11-16', endDate: '2026-11-18', reason: 'Family trip' } }
    },
    'PUT timeoff/:id/decision': {
        group: 'Time Off Requests', purpose: 'Approve or reject.', request: { decision: 'Approved|Rejected *', comment: 'string' },
        rules: ['Only Pending requests', 'Approval warns about conflicting scheduled shifts']
    },
    'DELETE timeoff/:id': { group: 'Time Off Requests', purpose: 'Cancel a pending request.' },

    'GET forecasts': { group: 'Forecasts', purpose: 'Daily forecast records.', request: { query: { locationId: ID, from: 'date', to: 'date' } } },
    'POST forecasts/generate': {
        group: 'Forecasts', purpose: 'Generate forecasts from history (weighted 4-week moving average).', request: { locationId: ID, weeks: '1-12', growthPct: 'number', promoPct: 'number' },
        exampleRequest: { body: { weeks: 4, growthPct: 2, promoPct: 0 } }
    },
    'GET budgets': { group: 'Labor Budgets', purpose: 'Weekly budget vs scheduled vs actual with variance.', request: { query: { locationId: ID } } },
    'PUT budgets/:id': { group: 'Labor Budgets', purpose: 'Update weekly budget.', request: { budgetHours: 'number >= 0', budgetAmount: 'number >= 0', notes: 'string' } },

    'GET reports': { group: 'Reports', purpose: 'Recent report runs.' },
    'GET reports/:type': {
        group: 'Reports', purpose: 'Run a report: roster | schedule | attendance | laborcost | timeoff.', request: { query: { locationId: ID, weekStart: 'date', from: 'date', to: 'date', status: 'string', format: 'csv' } },
        exampleRequest: { params: { type: 'roster' }, query: { status: 'Active' } }
    },

    'GET admin/users': { group: 'Administration', purpose: 'List users.' },
    'POST admin/users': { group: 'Administration', purpose: 'Create a login.', request: { name: 'string *', email: 'string *', password: 'min 6 *', role: 'Employee|Manager|Administrator *', employeeId: ID } },
    'PUT admin/users/:id': { group: 'Administration', purpose: 'Update user / reset password.', rules: ['You cannot disable or demote yourself'] },
    'DELETE admin/users/:id': { group: 'Administration', purpose: 'Delete a user.' },
    'GET admin/settings': { group: 'Administration', purpose: 'Organization, system (WFM rules) and role settings.' },
    'PUT admin/settings/:key': {
        group: 'Administration', purpose: 'Update settings group organization | system | roles.',
        rules: ['Numeric rules must be positive', 'maxDailyHours <= maxWeeklyHours'], exampleRequest: { params: { key: 'system' }, body: { maxWeeklyHours: 45, minRestHours: 11 } }
    },
    'GET admin/audit': { group: 'Administration', purpose: 'Audit log search.', request: { query: { q: 'text', action: 'string', entity: 'string', page: 'number' } } },
    'POST admin/reseed': { group: 'Administration', purpose: 'Reset KP Retail Group demo data.' },
    'GET admin/api-docs': { group: 'Administration', purpose: 'This documentation, generated from the registered route table.' },
};

const rolesLabel = (r) => (r === null ? ['Public'] : r.length ? r : ['Any signed-in user']);

export function buildDocs(routes) {
    const endpoints = routes.map(([method, path, , roles, extra]) => {
        const d = extra || CORE_DOCS[`${method} ${path}`] || {};
        const group = d.group || path.split('/')[0];
        const params = (path.match(/:\w+/g) || []).map((p) => p.slice(1));
        return {
            id: `${method} /api/${path}`, method, path: `/api/${path}`, params, roles: rolesLabel(roles),
            group, direction: path.startsWith('integrations/inbound') ? 'Inbound' : path.startsWith('integrations/outbound') ? 'Outbound' : 'Core',
            purpose: d.purpose || 'No description provided.', request: d.request || (method === 'GET' ? { query: 'none' } : {}),
            response: d.response || 'JSON object', rules: [...(roles === null ? [] : ['Requires Authorization: Bearer <token>']), ...(d.rules || [])],
            exampleRequest: d.exampleRequest || {}, exampleResponse: d.exampleResponse || null, documented: !!(extra || CORE_DOCS[`${method} ${path}`]),
        };
    });
    return {
        title: 'KP WFM API', version: '1.1', baseUrl: '/api', generatedAt: new Date().toISOString(),
        authentication: 'POST /api/auth/login → use the returned token as "Authorization: Bearer <token>".',
        errorFormat: { error: 'message', details: '[string] (validation errors)' },
        statusCodes: { 200: 'OK', 400: 'Bad request', 401: 'Not authenticated', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict / integrity violation', 413: 'Batch too large', 422: 'WFM rule violation', 423: 'Published schedule locked – enable Edit Mode', 500: 'Server error' },
        total: endpoints.length, endpoints,
    };
}
