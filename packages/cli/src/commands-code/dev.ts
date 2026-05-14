import { repl } from "./repl"

export async function dev(_flags: string[] = []): Promise<void> {
  await repl()
}
