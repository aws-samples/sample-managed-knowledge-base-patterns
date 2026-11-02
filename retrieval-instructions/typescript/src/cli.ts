/**
 * ri-sample: per-tenant retrieval instructions on a shared managed knowledge base.
 *
 * Run from the pattern directory with `npm run -s ri-sample -- <command> [options]`.
 */

import { parseArgs } from 'node:util';
import * as commands from './commands';
import { SampleError, awsError, isServiceError } from './errors';
import { STATE_FILE } from './paths';

const STREAM_TIMEOUT = 'no data from the service for 120 s; run the command again';
const DESCRIPTION =
  'ri-sample: per-tenant retrieval instructions on a shared managed knowledge base.\n\n' +
  'Run from the pattern directory with `npm run -s ri-sample -- <command> [options]`.';

interface Option {
  name: string;
  kind: 'string' | 'int' | 'boolean';
  required?: boolean;
  help?: string;
}

interface Command {
  name: string;
  help: string;
  options: Option[];
  exclusive?: [string, string];
}

const QUOTA: Option = {
  name: 'quota',
  kind: 'int',
  help: 'retrieval instruction quota (default 50)',
};
const REGION: Option = {
  name: 'region',
  kind: 'string',
  help: 'a sales region key, with a team tenant only',
};
const QUESTION: Option = { name: 'question', kind: 'string', required: true };
const VERSION: Option = {
  name: 'version',
  kind: 'string',
  help: 'DRAFT or a version number (default: the live pin)',
};

const COMMANDS: Command[] = [
  {
    name: 'status',
    help: 'stack, ingestion, quota headroom, and the sample instructions',
    options: [
      {
        name: 'wait',
        kind: 'boolean',
        help: 'poll ingestion every 10 s for up to 30 minutes',
      },
      QUOTA,
    ],
  },
  {
    name: 'create-instructions',
    help: 'create, review, and version the sample instructions',
    options: [
      {
        name: 'combined',
        kind: 'boolean',
        help: 'also create the four combined-cell instructions',
      },
      QUOTA,
    ],
  },
  {
    name: 'baseline',
    help: 'ask with no retrieval instruction',
    options: [
      QUESTION,
      {
        name: 'tenant',
        kind: 'string',
        help: 'add the tenant line and filter, still with no instruction',
      },
      REGION,
    ],
  },
  {
    name: 'ask',
    help: 'ask as a tenant: its instruction, tenant line, and filter',
    options: [
      { name: 'tenant', kind: 'string', required: true },
      QUESTION,
      REGION,
      VERSION,
      {
        name: 'request-index',
        kind: 'int',
        help: 'let the release configuration route request N',
      },
      {
        name: 'trace',
        kind: 'boolean',
        help: 'also print the first Planning trace event',
      },
    ],
    exclusive: ['version', 'request-index'],
  },
  {
    name: 'isolation',
    help: 'list retrieved documents without and with the tenant filter',
    options: [{ name: 'tenant', kind: 'string', required: true }, QUESTION, REGION],
  },
  {
    name: 'structured-json',
    help: 'ask for the five-key JSON reply and validate it',
    options: [QUESTION],
  },
  {
    name: 'multi-kb',
    help: 'one instruction across the shared and the South knowledge base',
    options: [
      QUESTION,
      VERSION,
      {
        name: 'no-filters',
        kind: 'boolean',
        help: 'send the same request with no retriever filters',
      },
    ],
  },
  {
    name: 'support-v2',
    help: 'update the support instruction and create version 2',
    options: [],
  },
  {
    name: 'release show',
    help: 'print the release configuration and the recorded versions',
    options: [],
  },
  {
    name: 'release set',
    help: 'set the live version and an optional canary',
    options: [
      { name: 'tenant', kind: 'string', required: true },
      { name: 'live', kind: 'string', required: true },
      {
        name: 'canary',
        kind: 'string',
        help: 'version that gets one request in --every',
      },
      { name: 'every', kind: 'int' },
    ],
  },
  {
    name: 'release route',
    help: 'print the version each request index gets',
    options: [
      { name: 'tenant', kind: 'string', required: true },
      { name: 'requests', kind: 'int', help: 'request indexes to route (default 10)' },
    ],
  },
  {
    name: 'cloudtrail',
    help: 'GetRetrievalInstruction calls Amazon Bedrock made, from event history',
    options: [
      { name: 'since', kind: 'int', help: 'minutes to look back (default 60)' },
      { name: 'wait', kind: 'boolean', help: 'poll every 60 s for up to 15 minutes' },
    ],
  },
  {
    name: 'verify-abac',
    help: 'check the tenant role tag conditions',
    options: [
      { name: 'tenant', kind: 'string', help: 'default: the first tenant with roles' },
      {
        name: 'other',
        kind: 'string',
        help: 'another sales region tenant (default sales-region-central)',
      },
    ],
  },
  {
    name: 'teardown',
    help: 'delete the sample instructions (prints the plan without --yes)',
    options: [
      { name: 'yes', kind: 'boolean', help: 'delete versions, then instructions' },
    ],
  },
];

/** `release` on its own: a group of three commands, with help but no options. */
const RELEASE: Command = {
  name: 'release',
  help: 'the per-tenant release configuration in sample-state.json',
  options: [],
};

/** A usage error: exit 2 with the command's usage line, as argparse does. */
class UsageExit extends Error {}

function metavar(option: Option): string {
  return option.name.toUpperCase().replaceAll('-', '_');
}

function usage(command: Command | null): string {
  if (command === null) return 'usage: ri-sample [-h] <command> ...';
  if (command === RELEASE) return 'usage: ri-sample release [-h] <command> ...';
  const parts = command.options.map((o) => {
    const text = o.kind === 'boolean' ? `--${o.name}` : `--${o.name} ${metavar(o)}`;
    return o.required ? text : `[${text}]`;
  });
  return ['usage: ri-sample', command.name, '[-h]', ...parts].join(' ');
}

function helpText(command: Command | null): string {
  const lines = [usage(command), ''];
  if (command === null) {
    lines.push(DESCRIPTION, '', 'commands:');
    for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(22)}${c.help}`);
    lines.push(
      '',
      'options:',
      '  -h, --help            show this help message and exit',
    );
  } else if (command === RELEASE) {
    lines.push(command.help, '', 'commands:');
    for (const c of COMMANDS.filter((c) => c.name.startsWith('release '))) {
      lines.push(`  ${c.name.slice('release '.length).padEnd(22)}${c.help}`);
    }
    lines.push(
      '',
      'options:',
      '  -h, --help            show this help message and exit',
    );
  } else {
    lines.push(
      command.help,
      '',
      'options:',
      '  -h, --help            show this help message and exit',
    );
    for (const o of command.options) {
      const flag = o.kind === 'boolean' ? `--${o.name}` : `--${o.name} ${metavar(o)}`;
      if (!o.help) lines.push(`  ${flag}`);
      else if (flag.length < 21) lines.push(`  ${flag.padEnd(22)}${o.help}`);
      else lines.push(`  ${flag}`, `${' '.repeat(24)}${o.help}`);
    }
  }
  return lines.join('\n') + '\n';
}

type Values = Record<string, string | boolean | number | undefined>;

function parseCommand(command: Command, argv: string[]): Values | 'help' {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {
    help: { type: 'boolean', short: 'h' },
  };
  for (const o of command.options)
    options[o.name] = { type: o.kind === 'boolean' ? 'boolean' : 'string' };
  let parsed: Record<string, string | boolean | (string | boolean)[] | undefined>;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    throw new UsageExit(err instanceof Error ? err.message : String(err));
  }
  if (parsed.help) return 'help';
  const values: Values = {};
  for (const o of command.options) {
    const raw = parsed[o.name];
    if (raw === undefined) {
      if (o.required)
        throw new UsageExit(`the following arguments are required: --${o.name}`);
      continue;
    }
    if (o.kind === 'int') {
      const text = String(raw).trim();
      if (!/^[-+]?[0-9]+$/.test(text)) {
        throw new UsageExit(
          `argument --${o.name}: invalid int value: '${String(raw)}'`,
        );
      }
      values[o.name] = Number(text);
    } else {
      values[o.name] = raw as string | boolean;
    }
  }
  const [a, b] = command.exclusive ?? [];
  if (a && b && values[a] !== undefined && values[b] !== undefined) {
    throw new UsageExit(`argument --${b}: not allowed with argument --${a}`);
  }
  return values;
}

function findCommand(argv: string[]): [Command | null, string[]] {
  const [first, ...rest] = argv;
  if (first === undefined)
    throw new UsageExit('the following arguments are required: <command>');
  if (first === '-h' || first === '--help') return [null, []];
  if (first === 'release') {
    const [second, ...more] = rest;
    if (second === undefined) {
      throw new UsageExit('the following arguments are required: <command>');
    }
    if (second === '-h' || second === '--help') return [RELEASE, []];
    const command = COMMANDS.find((c) => c.name === `release ${second}`);
    if (command === undefined) {
      throw new UsageExit(
        `argument <command>: invalid choice: '${second}' (choose from show, set, route)`,
      );
    }
    return [command, more];
  }
  const command = COMMANDS.find(
    (c) => c.name === first && !c.name.startsWith('release '),
  );
  if (command === undefined) {
    const names = [...new Set(COMMANDS.map((c) => c.name.split(' ')[0]))].join(', ');
    throw new UsageExit(
      `argument <command>: invalid choice: '${first}' (choose from ${names})`,
    );
  }
  return [command, rest];
}

const str = (v: Values, k: string): string | null =>
  v[k] === undefined ? null : String(v[k]);
const num = (v: Values, k: string): number | null =>
  v[k] === undefined ? null : Number(v[k]);
const flag = (v: Values, k: string): boolean => v[k] === true;

async function dispatch(
  command: Command,
  v: Values,
  context: () => Promise<commands.Context>,
): Promise<number> {
  switch (command.name) {
    case 'release show':
      return commands.cmdReleaseShow(STATE_FILE);
    case 'release set':
      return commands.cmdReleaseSet(
        STATE_FILE,
        String(v.tenant),
        String(v.live),
        str(v, 'canary'),
        num(v, 'every'),
      );
    case 'release route':
      return commands.cmdReleaseRoute(
        STATE_FILE,
        String(v.tenant),
        num(v, 'requests') ?? 10,
      );
  }
  const ctx = await context();
  switch (command.name) {
    case 'status':
      return commands.cmdStatus(ctx, flag(v, 'wait'), num(v, 'quota') ?? 50);
    case 'create-instructions':
      return commands.cmdCreateInstructions(
        ctx,
        flag(v, 'combined'),
        num(v, 'quota') ?? 50,
      );
    case 'baseline':
      return commands.cmdBaseline(
        ctx,
        String(v.question),
        str(v, 'tenant'),
        str(v, 'region'),
      );
    case 'ask':
      return commands.cmdAsk(
        ctx,
        String(v.tenant),
        String(v.question),
        str(v, 'region'),
        str(v, 'version'),
        num(v, 'request-index'),
        flag(v, 'trace'),
      );
    case 'isolation':
      return commands.cmdIsolation(
        ctx,
        String(v.tenant),
        String(v.question),
        str(v, 'region'),
      );
    case 'structured-json':
      return commands.cmdStructuredJson(ctx, String(v.question));
    case 'multi-kb':
      return commands.cmdMultiKb(
        ctx,
        String(v.question),
        str(v, 'version'),
        flag(v, 'no-filters'),
      );
    case 'support-v2':
      return commands.cmdSupportV2(ctx);
    case 'cloudtrail':
      return commands.cmdCloudtrail(ctx, num(v, 'since') ?? 60, flag(v, 'wait'));
    case 'verify-abac':
      return commands.cmdVerifyAbac(ctx, str(v, 'tenant'), str(v, 'other'));
    default:
      return commands.cmdTeardown(ctx, flag(v, 'yes'));
  }
}

/** Exit codes: 0 success, 1 a check failed, 2 usage or a guard refused, 3 an AWS error. */
export async function main(
  argv: string[],
  context: () => Promise<commands.Context> = commands.defaultContext,
): Promise<number> {
  let command: Command | null = null;
  let values: Values | 'help';
  try {
    let rest: string[];
    [command, rest] = findCommand(argv);
    if (command === null || command === RELEASE) {
      process.stdout.write(helpText(command));
      return 0;
    }
    values = parseCommand(command, rest);
  } catch (err) {
    if (!(err instanceof UsageExit)) throw err;
    const prog = command ? `ri-sample ${command.name}` : 'ri-sample';
    process.stderr.write(`${usage(command)}\n${prog}: error: ${err.message}\n`);
    return 2;
  }
  if (values === 'help') {
    process.stdout.write(helpText(command));
    return 0;
  }
  try {
    return await dispatch(command, values, context);
  } catch (err) {
    if (err instanceof SampleError) {
      process.stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    if (isServiceError(err)) {
      process.stderr.write(`error: ${awsError(err).message}\n`);
      return 3;
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      process.stderr.write(`error: ${STREAM_TIMEOUT}\n`);
      return 3;
    }
    if (err instanceof Error) {
      process.stderr.write(`error: ${err.name}: ${err.message}\n`);
      return 3;
    }
    throw err;
  }
}

if (
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
