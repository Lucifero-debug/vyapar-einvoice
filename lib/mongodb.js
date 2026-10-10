import mongoose from "mongoose";

/**
 * Cached connection.
 *
 * This used to call `mongoose.connect()` without awaiting it, re-register the
 * event listeners on every request (leaking handlers until Node warned about
 * it), and call `process.exit()` from the error handler — which takes the whole
 * server down on a transient network blip.
 *
 * It also meant `connect()` resolved before the connection was live. Ordinary
 * queries survived that because Mongoose buffers them, but `startSession()` —
 * which transactions need — has no such safety net.
 *
 * The promise is cached on `globalThis` so the dev server's hot reload reuses
 * one connection instead of opening a new one per edit.
 */

const MONGO_URI = process.env.MONGO_URI;

let cached = globalThis.__mongoose;
if (!cached) {
  cached = globalThis.__mongoose = { conn: null, promise: null };
}

export async function connect() {
  if (cached.conn) return cached.conn;

  if (!MONGO_URI) {
    throw new Error("MONGO_URI is not set.");
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGO_URI, { bufferCommands: false })
      .then((m) => {
        console.log("MongoDB connected");
        return m;
      })
      .catch((err) => {
        // Clear the cache so the next request retries rather than being stuck
        // with a rejected promise forever.
        cached.promise = null;
        throw err;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export default connect;
