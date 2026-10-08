/** Audit logging helper - every write operation records who did what. */
import { newId } from './db.js';

export async function audit(db, user, action, entity, details = '', entityId = null) {
    try {
        await db.collection('auditlogs').insertOne({
            _id: newId(), timestamp: new Date().toISOString(), userId: user?.sub || null,
            userName: user?.name || 'System', userEmail: user?.email || '', role: user?.role || 'System',
            action, entity, entityId, details,
        });
    } catch (e) { console.error('audit failed', e.message); }
}
