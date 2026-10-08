/** Test-only OS credential facade; never reads or changes real user keys. */
const values = new Map<string, string>();
// Bun.secrets methods are read-only; its facade property is replaceable.
Object.defineProperty(Bun, "secrets", { value: {
  get: async ({ service, name }: {service: string; name: string}) => values.get(`${service}:${name}`) ?? null,
  set: async ({ service, name, value }: {service: string; name: string; value: string}) => { values.set(`${service}:${name}`, value); },
  delete: async ({ service, name }: {service: string; name: string}) => values.delete(`${service}:${name}`),
} });
