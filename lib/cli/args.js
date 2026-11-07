/**
 * CLI-2 command-line parsing: the whole `dsh-zen-remote` grammar in one pure
 * function. It answers WHAT the user asked for — command routing, option
 * values, targets — and deliberately does not VALIDATE cross-field rules
 * (role gates, required targets): the command layer renders those verdicts
 * through the i18n dictionary. Two things the parser does decide on its own:
 * `--role peer` (and any unknown role value) is flagged `roleIssue` because
 * SPEC pins the "peer is not enabled" refusal at every entry point, and
 * `--debug`'s optional path argument is consumed only when it does not look
 * like another flag.
 *
 * Global flags may appear before or after the command word; the leading
 * positional tokens ARE the command (`host device revoke dev-7` → three
 * command words + one target), everything flag-like is an option.
 */
/** `--flag value` options, mapped onto CliOptions field names. */
const VALUE_OPTIONS = {
    '--lang': 'lang',
    '--socket': 'socket',
    '--wait': 'wait',
    '--role': 'role',
    '--profile': 'profile',
    '--ingress': 'ingress',
    '--mode': 'mode',
    '--domain': 'domain',
    '--cf-token': 'cfToken',
    '--email': 'email',
    '--https-port': 'httpsPort',
    '--public-url': 'publicUrl',
    '--tunnel-id': 'tunnelId',
    '--proxy': 'proxy',
    '--device-role': 'deviceRole',
    '--host-url': 'hostUrl',
    '--code': 'code',
    '--name': 'name',
};
/** Boolean switches. `-y` is the only short alias (the one SPEC names). */
const BOOLEAN_OPTIONS = {
    '--json': 'json',
    '--yes': 'yes',
    '-y': 'yes',
    '--no-wait': 'noWait',
    '--all': 'all',
};
const KNOWN_ROLES = new Set(['host', 'client', 'peer']);
function defaultOptions() {
    return {
        json: false,
        yes: false,
        noWait: false,
        wait: 20,
        debug: false,
        all: false,
        unknownFlags: [],
    };
}
function assignValue(field, raw, options) {
    switch (field) {
        case 'wait': {
            const seconds = Number(raw);
            if (Number.isFinite(seconds) && seconds >= 0)
                options.wait = seconds;
            // A garbage value keeps the 20s default instead of poisoning the wait.
            return;
        }
        case 'profile': {
            const names = raw.split(',').map((name) => name.trim()).filter((name) => name !== '');
            options.profile = names;
            return;
        }
        case 'httpsPort': {
            const port = Number(raw);
            if (Number.isInteger(port) && port > 0)
                options.httpsPort = port;
            return;
        }
        case 'role': {
            options.role = raw;
            if (raw === 'peer')
                options.roleIssue = 'peer-not-enabled';
            else if (!KNOWN_ROLES.has(raw))
                options.roleIssue = 'invalid';
            return;
        }
        case 'lang':
            options.lang = raw;
            return;
        case 'socket':
            options.socket = raw;
            return;
        case 'ingress':
            options.ingress = raw;
            return;
        case 'mode':
            options.mode = raw;
            return;
        case 'domain':
            options.domain = raw;
            return;
        case 'cfToken':
            options.cfToken = raw;
            return;
        case 'email':
            options.email = raw;
            return;
        case 'publicUrl':
            options.publicUrl = raw;
            return;
        case 'tunnelId':
            options.tunnelId = raw;
            return;
        case 'proxy':
            options.proxy = raw;
            return;
        case 'deviceRole':
            options.deviceRole = raw;
            return;
        case 'hostUrl':
            options.hostUrl = raw;
            return;
        case 'code':
            options.code = raw;
            return;
        case 'name':
            options.name = raw;
            return;
    }
}
function setBooleanFlag(field, options) {
    switch (field) {
        case 'json':
            options.json = true;
            return;
        case 'yes':
            options.yes = true;
            return;
        case 'noWait':
            options.noWait = true;
            return;
        case 'all':
            options.all = true;
            return;
    }
}
/** Route the leading positional words into a command. Returns `undefined`
 * when the words name a valid command with a target slot still open
 * (`host device revoke …`), and a full verdict otherwise. */
function routeCommand(positionals, options) {
    const c1 = positionals[0];
    const c2 = positionals[1];
    const c3 = positionals[2];
    const unknown = (words) => ({
        command: 'unknown',
        options,
        unknownCommand: words.filter((word) => word !== undefined).join(' '),
    });
    if (c1 === 'setup')
        return { command: 'setup', options };
    if (c1 === 'status')
        return { command: 'status', options };
    if (c1 === 'host') {
        if (c2 === 'device' && (c3 === 'pair' || c3 === 'list' || c3 === 'revoke')) {
            // `revoke <id|--all>` is the only device verb with a target slot; an
            // `--all` positional means the flag, not a device literally named
            // "--all".
            let target = c3 === 'revoke' ? positionals[3] : undefined;
            if (target === '--all') {
                options.all = true;
                target = undefined;
            }
            return { command: `host.device.${c3}`, options, ...(target === undefined ? {} : { target }) };
        }
        if (c2 === 'ingress' && (c3 === 'start' || c3 === 'stop' || c3 === 'verify' || c3 === 'snippet')) {
            return { command: `host.ingress.${c3}`, options };
        }
        return unknown([c1, c2, c3]);
    }
    if (c1 === 'client') {
        if (c2 === 'pair' || c2 === 'unpair') {
            const target = positionals[2];
            return { command: `client.${c2}`, options, ...(target === undefined ? {} : { target }) };
        }
        if (c2 === 'list')
            return { command: 'client.list', options };
        return unknown([c1, c2]);
    }
    return unknown([c1]);
}
/**
 * Parse `argv` (without the node binary and script path) into a structured
 * command. `--help` / `-h` anywhere wins over everything, then `--version` /
 * `-v`; flags with no command still route to `help` (running the binary bare
 * must not fall into the interactive wizard).
 */
export function parseCliArgs(argv) {
    if (argv.includes('--help') || argv.includes('-h'))
        return { command: 'help', options: defaultOptions() };
    if (argv.includes('--version') || argv.includes('-v'))
        return { command: 'version', options: defaultOptions() };
    const options = defaultOptions();
    const positionals = [];
    let index = 0;
    while (index < argv.length) {
        const token = argv[index];
        if (token === undefined)
            break;
        index += 1;
        if (token === '--debug') {
            // `--debug [outPath]`: a following non-flag token is the output path,
            // anything else (nothing, another flag) means the default filename.
            const next = argv[index];
            if (next !== undefined && !next.startsWith('-')) {
                options.debugPath = next;
                index += 1;
            }
            else {
                options.debug = true;
            }
            continue;
        }
        const booleanField = BOOLEAN_OPTIONS[token];
        if (booleanField !== undefined) {
            setBooleanFlag(booleanField, options);
            continue;
        }
        const valueField = VALUE_OPTIONS[token];
        if (valueField !== undefined) {
            const next = argv[index];
            if (next === undefined || next.startsWith('-'))
                continue; // missing value — leave the field unset
            index += 1;
            assignValue(valueField, next, options);
            continue;
        }
        if (token.startsWith('-') && token.length > 1) {
            options.unknownFlags.push(token);
            continue;
        }
        positionals.push(token);
    }
    if (positionals.length === 0)
        return { command: 'help', options };
    return routeCommand(positionals, options);
}
//# sourceMappingURL=args.js.map