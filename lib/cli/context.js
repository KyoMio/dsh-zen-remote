/**
 * CLI-3: the execution context every command function receives. One bag with
 * everything a command needs but never constructs itself — the parsed
 * grammar, the live IPC client, the translator, and the interactivity
 * verdict — plus the seams tests inject (a clock, a poll interval, an
 * alternate working directory). Pure types: the real builder is CLI-5's
 * main.ts; the tests assemble the object literal directly.
 */
export {};
//# sourceMappingURL=context.js.map