/** Authentication: bcrypt password hashing + stateless JWT sessions. */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { HttpError } from './http.js';

const secret = () => process.env.JWT_SECRET || 'kp-wfm-dev-secret-change-me';

export const hashPassword = (p) => bcrypt.hashSync(p, 10);
export const checkPassword = (p, h) => bcrypt.compareSync(p || '', h || '');

export const signToken = (u) => jwt.sign(
    { sub: u._id, role: u.role, employeeId: u.employeeId || null, name: u.name, email: u.email },
    secret(), { expiresIn: '12h' });

export function getUser(req) {
    const h = req.headers.authorization || req.headers.Authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw new HttpError(401, 'Not authenticated');
    try { return jwt.verify(token, secret()); } catch { throw new HttpError(401, 'Session expired, please sign in again'); }
}

/** Throws 403 unless the user has one of the given roles. */
export function requireRole(user, roles) {
    if (roles && roles.length && !roles.includes(user.role)) throw new HttpError(403, 'You do not have permission for this action');
}

export const publicUser = ({ password, ...u }) => u;
