import { col } from "../storage/hive";
import type { UserChannelDoc } from "../storage/collections";
import { serializeConfig, deserializeConfig } from "../storage/crypto";
export function channelConfigId(user: string, channel: string, account: string): string {
  return `${user}:${channel}:${account}`;
}
export async function storeChannelConfig(user: string, channel: string, account: string, config: Record<string, unknown>, active: boolean): Promise<void> {
  const encrypted = await serializeConfig(config);
  const collection = await col<UserChannelDoc>("userChannels");
  const id = channelConfigId(user, channel, account);
  const previous = await collection.get(id);
  await collection.put(id, {
    id, user_id: user, channel, account_id: account, config: encrypted, active,
    created_at: previous?.doc.created_at ?? Date.now(), updated_at: Date.now(),
  }, { expectedVersion: previous?.version ?? 0 });
}
export async function readChannelConfig(channel: string, account: string, user = "default"): Promise<Record<string, any>> {
  const entry = await (await col<UserChannelDoc>("userChannels")).get(channelConfigId(user, channel, account));
  return entry ? deserializeConfig(entry.doc.config) : {};
}
