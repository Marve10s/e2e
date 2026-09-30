/**
 * Run-wide service resolution. Every process a run may start is one
 * service: a `defineService` handle a target lists (with every service it
 * depends on), or the process a target's `app.command` is (`app:<target>`,
 * which no `defineService` name can spell). Each is checked once into a
 * template, where `{port}` is the process's own port and every placeholder
 * names an address it may read; binding a template to the run's ports is
 * substitution and nothing else.
 */

import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest } from '../internal/ids.ts';
import { obj } from '../internal/objects.ts';
import { portKey, replaceServiceTokens, serviceTokens, tokenOf, type ServiceToken } from '../internal/service-tokens.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isLoopbackAddress, portOf, type NormalizedBaseUrl } from '../internal/urls.ts';
import { isServiceHandle, notAServiceHandle, serviceDefinition, type ServiceDefinition } from '../services.ts';
import type { CommandConfig, ServiceAddresses, ServiceContext, ServiceHandle } from '../types.ts';
import { checkLog, digestCommand, type Readiness, type ResolvedCommand } from './command.ts';
import { httpUrl } from './validate.ts';

/** A function service's `start` budget when it names none, a process's `startupTimeout` default. */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/** `{port}` and `{port:<name>}`: a process's own ports, as its declaration writes them. */
const OWN_PORT_PATTERN = /\{port(?::([^}]*))?\}/g;

/** The free ports the run assigned, keyed as `portKey` spells them. */
export type PortAssignments = Readonly<Record<string, number>>;

/** One free port the run must assign before anything spawns. */
export interface PortRequest {
  /** Where a worker's bootstrap carries it (`portKey`). */
  readonly key: string;
  /** The address to bind. */
  readonly host: string;
  /** What asked for it, for the error when it cannot be bound. */
  readonly owner: string;
}

/**
 * The primary address of a process, what `svc.url`, `svc.port`, and `{port}`
 * read: its `readyUrl` for a service, its `app.url` for an app command. The
 * port is its own (0 asks for a free one), or one of its named ports.
 */
export interface PrimaryAddress {
  readonly scheme: string;
  readonly host: string;
  readonly port: { readonly number: number } | { readonly named: string };
}

interface TemplateBase {
  readonly name: string;
  /** How errors and the reporter name it: `service "db"`, `target "web" command`. */
  readonly label: string;
  /** How a run narrates it: a service, or the process a target's `app.command` is. */
  readonly role: 'service' | 'app';
  /** Every service it depends on, directly or through another, in start order. */
  readonly dependencies: readonly string[];
}

/** A process as checked, before the run's ports: every string holds tokens, its own ports included. */
export interface ProcessTemplate extends TemplateBase {
  readonly kind: 'process';
  readonly command: CommandConfig<string>;
  readonly readyUrl: string | undefined;
  readonly teardown: CommandConfig<string> | undefined;
  readonly primary: PrimaryAddress | undefined;
  /** Named ports, each 0 for a free one. */
  readonly ports: Readonly<Record<string, number>>;
  /** The host the named ports bind and read on. */
  readonly namedHost: string;
}

/** A function service as checked. */
export interface FunctionTemplate extends TemplateBase {
  readonly kind: 'function';
  readonly start: (context: ServiceContext) => Promise<void>;
  readonly stop: ((context: ServiceContext) => Promise<void>) | undefined;
  readonly startupTimeout: number;
}

export type ServiceTemplate = ProcessTemplate | FunctionTemplate;

interface ResolvedBase extends TemplateBase {
  /**
   * The service's identity across attempts that share processes: its name,
   * how it spawns and settles (a process), and its dependencies' keys, so
   * one started against another instance of a dependency is its own. A
   * function service is its name and dependencies alone: a config reload
   * that edits its hooks shares the instance already running.
   */
  readonly key: string;
  /** Where every service it depends on is served, by name: a function service's `context.services`. */
  readonly services: Readonly<Record<string, ServiceAddresses>>;
}

/** A process bound to the run's ports: what the runner spawns and probes. */
export interface ResolvedProcessService extends ResolvedBase {
  readonly kind: 'process';
  readonly template: ProcessTemplate;
  readonly command: CommandConfig<string>;
  readonly readiness: Readiness;
  readonly teardown: ResolvedCommand | undefined;
  readonly address: ServiceAddresses;
}

/** A function service, run in the runner process. */
export interface ResolvedFunctionService extends ResolvedBase {
  readonly kind: 'function';
  readonly template: FunctionTemplate;
}

export type ResolvedService = ResolvedProcessService | ResolvedFunctionService;

/** The services every target's graph holds, in start order, and each target's own graph. */
export interface CollectedServices {
  /** Dependencies first, in target order, each target's list in order. */
  readonly definitions: readonly ServiceDefinition[];
  /** Each service's dependencies, direct or through another, in start order. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /** Each target's services and every one they depend on, in start order. */
  readonly graphs: ReadonlyMap<string, readonly string[]>;
}

/**
 * Collects the services each target lists and every service they depend on,
 * in one start order for the run: target order, each target's list in order,
 * every service after the services it depends on. A value that is not a
 * handle and two handles with one name are `INVALID_CONFIG`. A dependency is
 * a handle defined before its dependent, so the graph has no cycle.
 */
export function collectServices(targets: readonly { readonly name: string; readonly services: unknown }[]): CollectedServices {
  const handles = new Map<string, ServiceHandle>();
  const closures = new Map<string, ReadonlySet<string>>();
  const ordered: ServiceDefinition[] = [];
  const visit = (handle: ServiceHandle): ReadonlySet<string> => {
    const known = handles.get(handle.name);
    if (known !== undefined && known !== handle) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `two services are named "${handle.name}"; a name is one service across the run, so define it once with defineService and list that handle everywhere it is needed`,
      );
    }
    const visited = closures.get(handle.name);
    if (visited !== undefined) return visited;
    handles.set(handle.name, handle);
    const definition = serviceDefinition(handle);
    const closure = new Set<string>();
    for (const dependency of definition.dependsOn) {
      for (const name of visit(dependency)) closure.add(name);
      closure.add(dependency.name);
    }
    closures.set(handle.name, closure);
    ordered.push(definition);
    return closure;
  };
  const listed = targets.map(({ name, services }) => {
    if (services === undefined) return [name, new Set<string>()] as const;
    if (!Array.isArray(services)) {
      throw new ConfigurationError('INVALID_CONFIG', `target "${name}" services must be an array of defineService handles`);
    }
    const graph = new Set<string>();
    services.forEach((handle: unknown, index) => {
      if (!isServiceHandle(handle)) throw notAServiceHandle(handle, `target "${name}" services[${index}]`);
      for (const dependency of visit(handle)) graph.add(dependency);
      graph.add(handle.name);
    });
    return [name, graph] as const;
  });
  const position = new Map(ordered.map((definition, index) => [definition.name, index]));
  const inOrder = (names: Iterable<string>): readonly string[] => [...names].toSorted((a, b) => position.get(a)! - position.get(b)!);
  return {
    definitions: ordered,
    dependencies: new Map([...closures].map(([name, closure]) => [name, inOrder(closure)])),
    graphs: new Map(listed.map(([name, graph]) => [name, inOrder(graph)])),
  };
}

/** The templates of every collected service, in start order. */
export function serviceTemplates(collected: CollectedServices, projectRoot: string): Map<string, ServiceTemplate> {
  const templates = new Map<string, ServiceTemplate>();
  for (const definition of collected.definitions) {
    const { name } = definition;
    const label = `service "${name}"`;
    const dependencies = collected.dependencies.get(name) ?? [];
    if (definition.kind === 'function') {
      const { start, stop, startupTimeout } = definition;
      templates.set(name, { kind: 'function', name, label, role: 'service', dependencies, start, stop, startupTimeout: startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS });
      continue;
    }
    templates.set(
      name,
      processTemplate(
        {
          name,
          label,
          role: 'service',
          where: label,
          readyWhere: `${label}.readyUrl`,
          command: definition.command,
          readyUrl: definition.readyUrl,
          ports: definition.ports,
          teardown: definition.teardown,
          serves: undefined,
          dependencies,
          outOfScope: `which ${label} does not depend on; add it to dependsOn, so it is ready first`,
        },
        templates,
        projectRoot,
      ),
    );
  }
  return templates;
}

/**
 * One process to check into a template: a service's definition, or a target's
 * `app.command`. It may read the addresses of its `dependencies` only.
 */
export interface ProcessSpec extends TemplateBase, Pick<ProcessTemplate, 'command' | 'readyUrl' | 'teardown' | 'ports'> {
  /** The config path of its command, for errors: `service "db"`, `target "web" app.command`. */
  readonly where: string;
  /** The config path of its readiness URL. */
  readonly readyWhere: string;
  /** The address it serves when that is not its `readyUrl`: a target's `app.url`. */
  readonly serves: NormalizedBaseUrl | undefined;
  /** Completes `... uses the address of service "x", ` for one outside its dependencies. */
  readonly outOfScope: string;
}

/** A readiness URL's authority, parsed once: its scheme, its host, and what its port is. */
interface ReadyAuthority {
  readonly scheme: string;
  readonly host: string;
  readonly port: { readonly number: number } | { readonly named: string } | 'own';
  /** Everything before the port. */
  readonly head: string;
  /** Everything after it. */
  readonly rest: string;
}

/**
 * Parses a readiness URL: an absolute http(s) URL whose port is a number
 * (0 for a free one), `{port:<name>}`, `{port}`, or the scheme's default.
 */
function parseReadyUrl(raw: string, where: string): ReadyAuthority {
  const match = /^(https?):\/\/(\[[^\]]*\]|[^/?#:]*)(?::(\{port(?::[^}]*)?\}|\d*))?/i.exec(raw);
  httpUrl(raw.replace(OWN_PORT_PATTERN, '1'), where);
  if (match === null || match[2] === '') throw new ConfigurationError('INVALID_CONFIG', `${where} must be an http(s) URL`);
  const [head, scheme, host, port] = match;
  const hostname = new URL(`${scheme!}://${host!}`).hostname;
  const rest = raw.slice(head.length);
  const authority = { scheme: scheme!.toLowerCase(), host: hostname, head: `${scheme!}://${host!}`, rest };
  if (port === undefined || port === '') return { ...authority, port: { number: scheme!.toLowerCase() === 'https' ? 443 : 80 } };
  if (port === '{port}') return { ...authority, port: 'own' };
  if (port.startsWith('{')) return { ...authority, port: { named: port.slice('{port:'.length, -1) } };
  return { ...authority, port: { number: Number(port) } };
}

/**
 * Checks one process into its template. Its primary address comes from
 * `serves` (an app command's URL) or else its `readyUrl`; `{port}` is that
 * address's port and `{port:<name>}` one of its named ports, both rewritten
 * to its own placeholders, so every string reads addresses one way. A
 * placeholder must name a service in scope and an address that service has.
 * A process with a free port cannot `reuseExisting`: what already answers
 * does not serve the port the run assigns.
 */
export function processTemplate(spec: ProcessSpec, templates: ReadonlyMap<string, ServiceTemplate>, projectRoot: string): ProcessTemplate {
  const { name, label, role, where, readyWhere } = spec;
  const foreign = serviceTokens(spec.readyUrl ?? '').find((token) => token.service !== name);
  if (foreign !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${readyWhere} is where ${label} is probed, its own address, so it cannot be service "${foreign.service}"'s${
        role === 'app' ? `; the service serves the app, so drop app.command and write app: { url: ${foreign.service}.url }` : ''
      }`,
    );
  }
  const authority = spec.readyUrl === undefined ? undefined : parseReadyUrl(spec.readyUrl, readyWhere);
  let primary: PrimaryAddress | undefined;
  let readyUrl = spec.readyUrl;
  if (spec.serves !== undefined) {
    const served = new URL(spec.serves.href);
    primary = { scheme: served.protocol.slice(0, -1), host: served.hostname, port: { number: portOf(spec.serves) } };
  } else if (authority !== undefined) {
    const { scheme, host, port } = authority;
    if (port === 'own') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        role === 'app'
          ? `${readyWhere} uses {port}, but the target declares no url to take the port from`
          : `${readyWhere} uses {port}, but readyUrl is where the service's own port comes from: write port 0 there for a free one (http://127.0.0.1:0/health), or name a port of ports as {port:name}`,
      );
    }
    if ('number' in port && port.number === 0) {
      if (!isLoopbackAddress(host)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `${readyWhere} asks for a free port on ${host}, which takes only a literal loopback address the process will bind, 127.0.0.1 or [::1]`,
        );
      }
      readyUrl = `${authority.head}:{port}${authority.rest}`;
    }
    primary = { scheme, host, port };
  }
  // `{port}` names a port only where the process's own address asks for a
  // free one, or an app command's `app.url` fixes it. Anywhere else an old
  // config that meant the app's port would change meaning without a word.
  const ownPort = (at: string): string => {
    if (primary === undefined || (spec.serves === undefined && 'named' in primary.port)) {
      if (role === 'app') throw new ConfigurationError('INVALID_CONFIG', `${at} uses {port}, but the target declares no url to take the port from`);
      throw noOwnPort(at, label);
    }
    if (spec.serves === undefined && 'number' in primary.port && primary.port.number !== 0) {
      if (role === 'app') throw new ConfigurationError('INVALID_CONFIG', `${at} uses {port}, but the target declares no url to take the port from; the readyUrl port ${primary.port.number} is fixed, so write it directly`);
      throw fixedOwnPort(at, label, primary.port.number);
    }
    return tokenOf(name, 'port');
  };
  const self: ProcessTemplate = {
    kind: 'process',
    name,
    label,
    role,
    dependencies: spec.dependencies,
    command: spec.command,
    readyUrl: undefined,
    teardown: undefined,
    primary,
    ports: spec.ports,
    namedHost: primary !== undefined && isLoopbackAddress(primary.host) ? primary.host : '127.0.0.1',
  };
  const read = (value: string, at: string): string => {
    const own = value.replace(OWN_PORT_PATTERN, (_token, port: string | undefined) => {
      if (port === undefined) {
        return ownPort(at);
      }
      if (spec.ports[port] === undefined) throw unknownNamedPort(at, port, role, spec.ports);
      return tokenOf(name, 'port', port);
    });
    for (const token of serviceTokens(own)) {
      if (token.service === name) {
        checkAddress(self, token, at);
        continue;
      }
      const service = spec.dependencies.includes(token.service) ? templates.get(token.service) : undefined;
      if (service === undefined) {
        throw new ConfigurationError('INVALID_CONFIG', `${at} uses the address of service "${token.service}", ${spec.outOfScope}`);
      }
      checkAddress(service, token, at);
    }
    return own;
  };
  const command = readCommand(spec.command, where, read);
  const teardown = spec.teardown === undefined ? undefined : readCommand(spec.teardown, `${where}.teardown`, read);
  checkLog(command, where, projectRoot);
  if (teardown !== undefined) checkLog(teardown, `${where}.teardown`, projectRoot);
  const onFreePort = (primary !== undefined && 'number' in primary.port && primary.port.number === 0) || Object.values(spec.ports).includes(0);
  if (command.reuseExisting === true && onFreePort) {
    const noun = role === 'app' ? 'app' : 'service';
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where}.reuseExisting cannot find ${noun === 'app' ? 'an' : 'a'} ${noun} already running on a free port: port 0 is a new port every run; give the ${noun} a fixed port, or drop reuseExisting`,
    );
  }
  return { ...self, command, teardown, readyUrl: readyUrl === undefined ? undefined : read(readyUrl, readyWhere) };
}

/** A command with every args entry and env value mapped through `read`, told where each came from. */
function readCommand(command: CommandConfig<string>, where: string, read: (value: string, at: string) => string): CommandConfig<string> {
  const { args, env } = command;
  return obj({
    ...command,
    args: args?.map((arg) => read(arg, `${where}.args`)),
    env: env === undefined ? undefined : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, read(value, `${where}.env.${key}`)])),
  });
}

/** How an old service that read the app's port through `{port}` says it now. */
const APP_PORT_NOW =
  "to read the app's address, start the app as a service, const app = defineService({ name: 'app', executable, args: ['--port', '{port}'], readyUrl: 'http://127.0.0.1:0' }), give the target app: { url: app.url } and services: [app], and write app.port or app.url here with dependsOn: [app]";

/** `{port}` in a service whose own address asks for no free port: what it meant before, and how to say that now. */
function noOwnPort(at: string, label: string): ConfigurationError {
  return new ConfigurationError(
    'INVALID_CONFIG',
    `${at} uses {port}, which is now the service's own free port (it used to be the app's port), and ${label} asks for none: give it one with readyUrl: 'http://127.0.0.1:0', or name its ports in ports and write {port:name}; ${APP_PORT_NOW}`,
  );
}

/** `{port}` in a service on a fixed port, which an old config may have meant as the app's. */
function fixedOwnPort(at: string, label: string, port: number): ConfigurationError {
  return new ConfigurationError(
    'INVALID_CONFIG',
    `${at} uses {port}, but ${label} has the fixed port ${port}: write it directly; {port} is the service's own free port now (it used to be the app's port); ${APP_PORT_NOW}`,
  );
}

/** `{port:<name>}` for a port the process does not declare. */
function unknownNamedPort(at: string, port: string, role: 'service' | 'app', ports: Readonly<Record<string, number>>): ConfigurationError {
  if (role === 'app') {
    return new ConfigurationError(
      'INVALID_CONFIG',
      `${at} uses a named port, which only a service declares (defineService({ ports })); the app command's own port is {port}`,
    );
  }
  const declared = Object.keys(ports);
  return new ConfigurationError(
    'INVALID_CONFIG',
    `${at} uses {port:${port}}, but the service declares no port "${port}"; ${
      declared.length === 0 ? `declare it: ports: { ${port}: 0 }` : `its ports are ${declared.join(', ')}${didYouMean(port, declared)}`
    }`,
  );
}

/**
 * Refuses a placeholder for an address `service` does not have: a function
 * service has none, a process without a `readyUrl` no primary one, and a
 * port name must be one it declares.
 */
function checkAddress(service: ServiceTemplate, token: ServiceToken, at: string): void {
  const described = `${at} uses ${token.token}`;
  if (service.kind === 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `${described}, but service "${service.name}" is a function and has no address`);
  }
  if (token.port !== undefined) {
    if (service.ports[token.port] !== undefined) return;
    const declared = Object.keys(service.ports);
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${described}, but service "${service.name}" declares no port "${token.port}"${
        declared.length === 0 ? '; declare it in ports' : `; its ports are ${declared.join(', ')}${didYouMean(token.port, declared)}`
      }`,
    );
  }
  if (service.primary === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${described}, but service "${service.name}" has no primary address: it comes from its readyUrl; read a named port with ${token.kind}('name')`,
    );
  }
}

/**
 * Checks the placeholders one target string holds (`app.url`): each names a
 * service of the target's graph and an address that service has.
 */
export function checkTargetTokens(
  value: string,
  at: string,
  targetName: string,
  graph: readonly string[],
  templates: ReadonlyMap<string, ServiceTemplate>,
): void {
  for (const token of serviceTokens(value)) {
    const service = graph.includes(token.service) ? templates.get(token.service) : undefined;
    if (service === undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${at} uses the address of service "${token.service}", which target "${targetName}" does not list; add it to the target's services`,
      );
    }
    checkAddress(service, token, at);
  }
}

/** One service's addresses as its placeholders read them. */
interface BoundAddress {
  readonly address: ServiceAddresses;
  readonly namedHost: string;
}

/** `value` with every placeholder replaced by the address `lookup` finds; the templates already checked each one exists. */
function bind(value: string, lookup: (service: string) => BoundAddress): string {
  return replaceServiceTokens(value, (token) => {
    const { address, namedHost } = lookup(token.service);
    if (token.port !== undefined) {
      const port = String(address.ports[token.port]);
      return token.kind === 'port' ? port : `${token.port}://${namedHost}:${port}`;
    }
    return token.kind === 'port' ? String(address.port) : address.url!;
  });
}

/** How placeholders read a resolved service. */
function boundAddress(service: ResolvedService): BoundAddress {
  return service.kind === 'process'
    ? { address: service.address, namedHost: service.template.namedHost }
    : { address: { url: undefined, port: undefined, ports: {} }, namedHost: '127.0.0.1' };
}

/** `value` with every placeholder replaced by the address of a service in `services`. */
export function bindTokens(value: string, services: ReadonlyMap<string, ResolvedService>): string {
  return bind(value, (name) => boundAddress(services.get(name)!));
}

/** A process's addresses on the run's ports: a free port not assigned yet reads 0. */
function addressOf(template: ProcessTemplate, ports: PortAssignments): ServiceAddresses {
  const assigned = (declared: number, port?: string): number => (declared === 0 ? (ports[portKey(template.name, port)] ?? 0) : declared);
  const named = Object.fromEntries(Object.entries(template.ports).map(([port, declared]) => [port, assigned(declared, port)]));
  const { primary } = template;
  if (primary === undefined) return { url: undefined, port: undefined, ports: named };
  const port = 'named' in primary.port ? named[primary.port.named]! : assigned(primary.port.number);
  return { url: new URL(`${primary.scheme}://${primary.host}:${port}`).origin, port, ports: named };
}

/**
 * Binds the templates, in start order, to the run's `ports`: every
 * placeholder substituted, and each service keyed by what it runs and the
 * keys of the services it depends on. Without ports, every free port reads
 * 0: the addresses as declared, which the identities key on.
 */
export function bindServices(templates: Iterable<ServiceTemplate>, ports: PortAssignments): ReadonlyMap<string, ResolvedService> {
  const bound = new Map<string, ResolvedService>();
  for (const template of templates) {
    const { name, label, role, dependencies } = template;
    const services = Object.fromEntries(dependencies.map((dependency) => [dependency, boundAddress(bound.get(dependency)!).address]));
    const dependencyKeys = dependencies.map((dependency) => bound.get(dependency)!.key);
    if (template.kind === 'function') {
      const key = canonicalDigest({ name, kind: 'function', dependencies: dependencyKeys });
      bound.set(name, { kind: 'function', name, label, role, dependencies, template, key, services });
      continue;
    }
    const address = addressOf(template, ports);
    const own: BoundAddress = { address, namedHost: template.namedHost };
    const read = (value: string): string => bind(value, (service) => (service === name ? own : boundAddress(bound.get(service)!)));
    const command = readCommand(template.command, label, read);
    const readiness: Readiness = template.readyUrl === undefined ? { waitForExit: true } : { readyUrl: new URL(read(template.readyUrl)).href };
    const teardown = template.teardown === undefined ? undefined : { label: `${label} teardown`, command: readCommand(template.teardown, label, read) };
    const key = canonicalDigest(obj({ name, kind: 'process', command, readiness, teardown: teardown?.command, dependencies: dependencyKeys }));
    bound.set(name, { kind: 'process', name, label, role, dependencies, template, key, services, command, readiness, teardown, address });
  }
  return bound;
}

/** The free ports the templates ask the run for: each process's primary one first, then its named ones. */
export function portRequests(templates: Iterable<ServiceTemplate>): readonly PortRequest[] {
  const requests: PortRequest[] = [];
  for (const template of templates) {
    if (template.kind !== 'process') continue;
    const { primary } = template;
    if (primary !== undefined && 'number' in primary.port && primary.port.number === 0) {
      requests.push({ key: portKey(template.name, undefined), host: primary.host, owner: template.label });
    }
    for (const [port, declared] of Object.entries(template.ports)) {
      if (declared === 0) requests.push({ key: portKey(template.name, port), host: template.namedHost, owner: template.label });
    }
  }
  return requests;
}

/**
 * Two processes probing one fixed address cannot both start: the second
 * finds the first answering (`APP_ALREADY_RUNNING`). One process several
 * targets share is one `defineService`.
 */
export function rejectSharedProbes(services: Iterable<ResolvedService>): void {
  const probes = new Map<string, string>();
  for (const service of services) {
    if (service.kind !== 'process' || !('readyUrl' in service.readiness)) continue;
    const { origin, port } = new URL(service.readiness.readyUrl);
    if (port === '0') continue;
    const other = probes.get(origin);
    if (other !== undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${other} and ${service.label} both probe ${origin}, so the second would find the first answering; one process several targets share is one service, const app = defineService({ name: 'app', executable, args, readyUrl }), listed as services: [app] with app: { url: app.url } on each target that opens it`,
      );
    }
    probes.set(origin, service.label);
  }
}

/** Every service a run's targets need, in start order, as it enters the config digest: env values by name, never the ports the run assigns. */
export function digestServices(services: Iterable<ResolvedService>) {
  return [...services].map(({ template }) =>
    template.kind === 'function'
      ? obj({ name: template.name, kind: 'function', dependencies: template.dependencies, startupTimeout: template.startupTimeout })
      : obj({
          name: template.name,
          kind: 'process',
          dependencies: template.dependencies,
          command: digestCommand(template.command),
          readyUrl: template.readyUrl,
          primary: template.primary,
          ports: template.ports,
          teardown: template.teardown === undefined ? undefined : digestCommand(template.teardown),
        }),
  );
}
