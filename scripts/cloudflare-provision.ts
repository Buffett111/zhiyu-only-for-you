import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// Only these project resources may be created. Existing account-wide settings are never changed.
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
const ADMIN_EMAILS = [...new Set((process.env.ADMIN_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean))];
const TUNNEL_NAME = 'zhiyu-local';
const SERVICE_NAME = 'zhiyu-api';
const WORKER_NAME = 'zhiyu';
const cacheDir = resolve('.cache');
const stateFile = resolve(cacheDir, 'cloudflare-state.json');
const apply = process.argv.includes('--apply');
const accessOnly = process.argv.includes('--access-only');
const teamDomainArgument = process.argv.find(arg => arg.startsWith('--team-domain='))?.slice('--team-domain='.length);

interface ApiEnvelope<T> { result: T; success: boolean; errors?: { code: number }[]; result_info?: { total_pages?: number } }
interface Resource { id?: string; name?: string; domain?: string; aud?: string; type?: string; service_id?: string; host?: { hostname?: string; ipv4?: string; network?: { tunnel_id?: string }; resolver_network?: { tunnel_id?: string } }; http_port?: number; https_port?: number; config_src?: string; allowed_idps?: string[]; }
interface Blocker { operation: string; httpStatus?: number; codes?: number[]; requiredPermission?: string; reason?: string; }
interface State {
  accountId: string; workerName: string; adminEmail: string; checkedAt: string; applied: boolean;
  workersSubdomain?: string; workerHostname?: string; tunnelId?: string; tunnelConfigSource?: string;
  vpcServiceId?: string; accessAppId?: string; accessAud?: string; accessTeamDomain?: string;
  otpProviderId?: string; tunnelTokenFile?: string; blockers: Blocker[];
  otpMode?: 'default' | 'explicit';
}
class CloudflareError extends Error {
  constructor(readonly operation: string, readonly httpStatus: number, readonly codes: number[]) {
    super(`${operation}: HTTP ${httpStatus}, codes ${codes.join(',') || 'none'}`);
  }
}
class ConfigurationError extends Error { override name = 'ConfigurationError'; }
const permissionFor = (operation: string): string => operation.includes('identity_providers') || operation.includes('organizations')
  ? 'Access: Organizations, Identity Providers, and Groups Write'
  : operation.includes('access/apps') ? 'Access: Apps and Policies Write'
    : operation.includes('cfd_tunnel') ? 'Cloudflare Tunnel Write'
      : operation.includes('connectivity/directory') ? 'Connectivity Directory Admin' : 'Workers Scripts Write';

async function main() {
  if (!/^[a-f0-9]{32}$/i.test(ACCOUNT_ID)) throw new ConfigurationError('Set CLOUDFLARE_ACCOUNT_ID to the account ID in your local .env.');
  if (!ADMIN_EMAILS.length || ADMIN_EMAILS.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ConfigurationError('Set ADMIN_EMAILS to a comma-separated list of invited administrators in your local .env.');
  await mkdir(cacheDir, { recursive: true });
  const old: Partial<State> = await readFile(stateFile, 'utf8').then(value => JSON.parse(value)).catch(() => ({}));
  if (old.accountId && old.accountId !== ACCOUNT_ID) throw new ConfigurationError('Saved state belongs to a different Cloudflare account.');
  const state: State = { ...old, accountId: ACCOUNT_ID, workerName: WORKER_NAME, adminEmail: ADMIN_EMAILS[0], checkedAt: new Date().toISOString(), applied: apply, blockers: [] };
  const profileRoot = process.env.XDG_CONFIG_HOME || (process.platform === 'win32'
    ? resolve(process.env.APPDATA || resolve(homedir(), 'AppData', 'Roaming'), 'xdg.config')
    : process.platform === 'darwin' ? resolve(homedir(), 'Library', 'Preferences') : resolve(homedir(), '.config'));
  const credentialPath = resolve(profileRoot, '.wrangler', 'config', 'default.toml');
  // Authentication is loaded directly into process memory; neither the file nor tokens are logged.
  const credential = process.env.CLOUDFLARE_API_TOKEN || (await readFile(credentialPath, 'utf8')).match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!credential) throw new Error('No Cloudflare credential found in the configured Wrangler profile.');
  async function request<T>(path: string, method = 'GET', body?: object): Promise<ApiEnvelope<T>> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/${path}`, {
      method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    const payload = await response.json() as ApiEnvelope<T>;
    if (!response.ok || !payload.success) throw new CloudflareError(`${method} ${path.split('?')[0]}`, response.status, payload.errors?.map(error => error.code) ?? []);
    return payload;
  }
  async function list(path: string): Promise<Resource[]> {
    const output: Resource[] = [];
    for (let page = 1; page <= 100; page++) {
      const payload = await request<Resource[]>(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`);
      if (!Array.isArray(payload.result)) throw new Error('Unexpected Cloudflare listing shape.');
      output.push(...payload.result);
      if (page >= (payload.result_info?.total_pages ?? 1)) return output;
    }
    throw new Error('Cloudflare listing exceeded the bounded page limit.');
  }
  const addBlocker = (operation: string, error: unknown) => {
    const blocker: Blocker = error instanceof CloudflareError
      ? { operation: error.operation, httpStatus: error.httpStatus, codes: error.codes, requiredPermission: permissionFor(error.operation) }
      : { operation, reason: error instanceof Error ? error.name : 'Unavailable' };
    state.blockers.push(blocker);
    console.info(JSON.stringify({ event: 'cloudflare-blocked', ...blocker }));
  };
  const save = () => writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const inventory = await Promise.allSettled([
    request<{ subdomain?: string }>('workers/subdomain'),
    list(`cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false`),
    list('connectivity/directory/services'),
    list('access/apps'),
    list('access/identity_providers'),
    request<{ auth_domain?: string }>('access/organizations'),
  ] as const);
  const paths = ['workers/subdomain', 'cfd_tunnel', 'connectivity/directory/services', 'access/apps', 'access/identity_providers', 'access/organizations'];
  inventory.forEach((result, index) => { if (result.status === 'rejected') addBlocker(`GET ${paths[index]}`, result.reason); });
  const [domainResult, tunnelResult, serviceResult, appResult, identityResult, organizationResult] = inventory;
  if (domainResult.status === 'fulfilled' && domainResult.value.result.subdomain) {
    state.workersSubdomain = domainResult.value.result.subdomain;
    state.workerHostname = `${WORKER_NAME}.${state.workersSubdomain}.workers.dev`;
  }
  const orgDomain = organizationResult.status === 'fulfilled' ? organizationResult.value.result.auth_domain : undefined;
  // --team-domain is for an organization the operator has verified in the dashboard when OAuth cannot read it.
  const teamDomain = orgDomain || teamDomainArgument || old.accessTeamDomain;
  if (teamDomain && /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) state.accessTeamDomain = teamDomain;
  const tunnels = tunnelResult.status === 'fulfilled' ? tunnelResult.value.filter(item => item.name === TUNNEL_NAME) : [];
  const services = serviceResult.status === 'fulfilled' ? serviceResult.value.filter(item => item.name === SERVICE_NAME) : [];
  const apps = appResult.status === 'fulfilled' ? appResult.value.filter(item => item.name === '知隅' && item.domain === state.workerHostname) : [];
  const providers = identityResult.status === 'fulfilled' ? identityResult.value.filter(item => item.type === 'onetimepin') : [];
  if (tunnels.length > 1 || services.length > 1 || apps.length > 1) throw new Error('Multiple matching project resources exist; exact resource IDs must be resolved before applying.');
  if (tunnels[0]?.id) { state.tunnelId = tunnels[0].id; state.tunnelConfigSource = tunnels[0].config_src; }
  if (services[0]?.service_id) state.vpcServiceId = services[0].service_id;
  if (apps[0]?.id) { state.accessAppId = apps[0].id; state.accessAud = apps[0].aud; }
  if (providers[0]?.id) state.otpProviderId = providers[0].id;
  const defaultOtp = identityResult.status === 'fulfilled' && identityResult.value.length === 0;
  if (defaultOtp) { delete state.otpProviderId; state.otpMode = 'default'; }
  else if (state.otpProviderId) state.otpMode = 'explicit';
  console.info(JSON.stringify({ event: 'cloudflare-inventory', workerHostname: state.workerHostname,
    projectTunnel: tunnels.length, projectVpcService: services.length, projectAccessApp: apps.length,
    otpProviders: providers.length, organizationKnown: Boolean(state.accessTeamDomain), mode: apply ? 'apply' : 'read-only' }));
  await save();
  if (!apply) return;

  if (!accessOnly && tunnelResult.status === 'fulfilled' && !state.tunnelId) {
    try {
      const result = await request<Resource>('cfd_tunnel', 'POST', { name: TUNNEL_NAME, config_src: 'cloudflare' });
      if (!result.result.id) throw new Error('Created tunnel response missing ID.');
      state.tunnelId = result.result.id; state.tunnelConfigSource = result.result.config_src;
      console.info(JSON.stringify({ event: 'project-tunnel-created', id: state.tunnelId })); await save();
    } catch (error) { addBlocker('POST cfd_tunnel', error); }
  }
  if (!accessOnly && state.tunnelId && serviceResult.status === 'fulfilled') {
    const currentService = services[0];
    const existingTunnel = currentService?.host?.network?.tunnel_id;
    if (currentService && (currentService.type !== 'http' || currentService.host?.ipv4 !== '127.0.0.1' || currentService.http_port !== 3001 || currentService.https_port != null || existingTunnel !== state.tunnelId)) {
      state.blockers.push({ operation: 'vpc-service-configuration', reason: 'Existing zhiyu-api service does not match HTTP 127.0.0.1:3001 and the project tunnel; left unchanged.' });
    } else if (!currentService) {
      try {
        const result = await request<Resource>('connectivity/directory/services', 'POST', {
          name: SERVICE_NAME, type: 'http', http_port: 3001,
          // Match the API's IPv4 loopback listener; localhost may resolve to ::1 on Windows.
          host: { ipv4: '127.0.0.1', network: { tunnel_id: state.tunnelId } },
        });
        if (!result.result.service_id) throw new Error('Created VPC service response missing ID.');
        state.vpcServiceId = result.result.service_id;
        console.info(JSON.stringify({ event: 'project-vpc-created', id: state.vpcServiceId })); await save();
      } catch (error) { addBlocker('POST connectivity/directory/services', error); }
    }
  }
  if (!accessOnly && state.tunnelId && state.tunnelConfigSource === 'cloudflare') {
    try {
      const payload = await request<string>(`cfd_tunnel/${state.tunnelId}/token`);
      if (typeof payload.result !== 'string' || payload.result.length < 20) throw new Error('Tunnel connector token unavailable.');
      const tokenFile = resolve(cacheDir, 'zhiyu-tunnel-token.txt');
      await writeFile(tokenFile, payload.result, { mode: 0o600 });
      state.tunnelTokenFile = tokenFile;
      console.info(JSON.stringify({ event: 'tunnel-token-saved', path: tokenFile })); await save();
    } catch (error) { addBlocker('GET project-tunnel/token', error); }
  }
  // Zero Trust uses one-time PIN by default when there are no configured identity providers.
  // Reuse that built-in method rather than changing account-wide identity-provider configuration.
  if (state.workerHostname && state.accessTeamDomain && (state.otpProviderId || defaultOtp) && appResult.status === 'fulfilled' && !state.accessAppId) {
    try {
      const result = await request<Resource>('access/apps', 'POST', {
        name: '知隅', type: 'self_hosted', domain: state.workerHostname, session_duration: '24h',
        ...(state.otpProviderId ? { allowed_idps: [state.otpProviderId] } : {}), auto_redirect_to_identity: false,
        app_launcher_visible: false, http_only_cookie_attribute: true,
        policies: [{ name: '知隅受邀使用者', decision: 'allow', include: ADMIN_EMAILS.map(email => ({ email: { email } })) }],
      });
      if (!result.result.id || !result.result.aud) throw new Error('Created Access application response missing ID or audience.');
      state.accessAppId = result.result.id; state.accessAud = result.result.aud;
      console.info(JSON.stringify({ event: 'project-access-created', id: state.accessAppId, hostname: state.workerHostname })); await save();
    } catch (error) { addBlocker('POST access/apps', error); }
  }
  if (!state.accessTeamDomain) state.blockers.push({ operation: 'access-organization', reason: 'Zero Trust organization could not be verified. Complete account setup in the dashboard, then pass its exact --team-domain.' });
  if (!state.workerHostname) state.blockers.push({ operation: 'workers-subdomain', reason: 'No existing workers.dev account subdomain was found.' });
  await save();
  console.info(JSON.stringify({ event: 'cloudflare-provision-result', ready: Boolean(state.tunnelId && state.vpcServiceId && state.accessAppId && state.accessAud && state.accessTeamDomain && state.tunnelTokenFile), blockers: state.blockers.length, stateFile }));
}

main().catch(error => {
  // Never print request objects, headers, response bodies, credentials, or raw fetch errors.
  console.error(JSON.stringify({ event: 'cloudflare-provision-failed', reason: error instanceof CloudflareError || error instanceof ConfigurationError ? error.message : error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
