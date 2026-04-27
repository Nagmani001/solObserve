import { connect, type JetStreamClient, type NatsConnection } from "nats";

let connPromise: Promise<NatsConnection> | null = null;

async function getConn(): Promise<NatsConnection> {
  if (!connPromise) {
    const servers = process.env.NATS_URL || "nats://localhost:4222";
    connPromise = connect({ servers });
  }
  return connPromise;
}

export async function getJetstream(): Promise<JetStreamClient> {
  const conn = await getConn();
  return conn.jetstream();
}
