/**
 * Hub de tempo real: fan-out de eventos MQTT/REST para todos os clientes WebSocket.
 * É o que permite o navegador "confirmar em tempo real" o estado da porta.
 */

export type HubEvent =
  | { type: 'hello'; unit?: undefined; payload: { server_time: string; units_online: number } }
  | { type: 'snapshot'; payload: { units: unknown[]; events: unknown[] } }
  | { type: 'telemetry'; unit: string; payload: Record<string, unknown> }
  | { type: 'door'; unit: string; payload: Record<string, unknown> }
  | { type: 'status'; unit: string; payload: Record<string, unknown> }
  | { type: 'command'; unit: string; payload: Record<string, unknown> }
  | { type: 'ack'; unit: string; payload: Record<string, unknown> };

type Client = {
  send: (data: string) => void;
  onClose: (cb: () => void) => void;
};

const clients = new Set<Client>();

export const hub = {
  add(client: Client): void {
    clients.add(client);
    client.onClose(() => clients.delete(client));
  },

  size(): number {
    return clients.size;
  },

  broadcast(event: HubEvent): void {
    const frame = JSON.stringify({ ...event, ts: new Date().toISOString() });
    for (const client of clients) {
      try {
        client.send(frame);
      } catch {
        clients.delete(client);
      }
    }
  },
};
