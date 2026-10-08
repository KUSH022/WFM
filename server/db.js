/**
 * MongoDB connection helper.
 * The client promise is cached on globalThis so warm serverless invocations reuse the connection
 * (important for the Atlas free tier connection limit).
 */
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';

const cache = globalThis.__kpMongo || (globalThis.__kpMongo = { promise: null });

export async function getDb() {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI environment variable is not set');
    if (!cache.promise) {
        cache.promise = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 }).connect()
            .catch((e) => { cache.promise = null; throw e; });
    }
    const client = await cache.promise;
    return client.db(process.env.MONGODB_DB || 'kpwfm');
}

/** Short string id used as _id for every document (keeps the API free of ObjectId conversions). */
export const newId = () => randomUUID().replace(/-/g, '').slice(0, 24);

export const COLLECTIONS = ['users', 'employees', 'locations', 'schedules', 'shifts', 'timecards',
    'timeoffrequests', 'forecasts', 'laborbudgets', 'reports', 'auditlogs', 'settings'];
