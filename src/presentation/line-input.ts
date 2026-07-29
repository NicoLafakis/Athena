import { createInterface, type Interface } from 'node:readline/promises'

export interface LineInput {
  readLine(prompt: string): Promise<string>
  close(): void
}

/** Native line input with terminal editing disabled. The presentation layer serializes
 * calls, so announcements never rewrite an active prompt. */
export class ReadlineLineInput implements LineInput {
  private readonly readline: Interface

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.readline = createInterface({ input, output, terminal: false })
  }

  readLine(prompt: string): Promise<string> {
    return this.readline.question(prompt)
  }

  close(): void {
    this.readline.close()
  }
}
