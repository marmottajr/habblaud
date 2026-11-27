// Instalador da extensão do omp (scripts/omp-install.ts): planos puros e o comando de verdade em pastas temporárias
// (HOME e HABBLAUD_OMP_DIRS FALSOS: nunca toca em ~/.omp). O ponto principal: o loader é o único arquivo que muda;
// as extensões de outros apps (ex.: orca-agent-status.ts) ficam idênticas, byte a byte.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configPath,
  EXTENSION_FILE,
  installState,
  isOurs,
  loaderContent,
  loaderTarget,
  MARK,
  parseArgs,
  planInstall,
  planUninstall,
  readConfigPort,
  run,
  type Health,
  type RunOptions,
} from '../../scripts/omp-install';
import { tempDir } from './fixtures';

const SOURCE = '/repo/habblaud/mod/habblaud-omp/habblaud.ts';
/** Extensão de outro app, com bytes que um parser reformataria (CRLF, sem newline no fim). */
const ORCA = '// @orca-managed-pi-extension\r\nexport default function (pi) {}';

describe('omp-install.ts (funções puras)', () => {
  it('loader: marca na primeira linha e um export que aponta para o arquivo do repositório', () => {
    const c = loaderContent(SOURCE);
    expect(c.split('\n', 1)[0]).toBe(MARK);
    expect(c).toContain(`export { default } from ${JSON.stringify(pathToFileURL(SOURCE).href)};`);
    expect(isOurs(c)).toBe(true);
    expect(isOurs(ORCA)).toBe(false);
    expect(isOurs('')).toBe(false);
    expect(loaderTarget(c)).toBe(fileURLToPath(pathToFileURL(SOURCE)));
  });

  it('loader com caminho de Windows e espaços vira file:/// e volta', () => {
    const spaced = process.platform === 'win32' ? 'C:\\Users\\Maria Silva\\habblaud\\mod\\habblaud-omp\\habblaud.ts' : '/home/maria silva/habblaud/mod/habblaud-omp/habblaud.ts';
    const c = loaderContent(spaced);
    expect(c).toMatch(/from "file:\/\/\/?[^"]*%20[^"]*habblaud\.ts";/);
    expect(loaderTarget(c)).toBe(spaced);
  });

  it('planos: instala, atualiza o que é nosso, não sobrescreve nem apaga o que não é', () => {
    expect(planInstall(undefined, SOURCE).action).toBe('install');
    expect(planInstall(loaderContent(SOURCE), SOURCE).action).toBe('none');
    const moved = planInstall(loaderContent('/outro/lugar/habblaud.ts'), SOURCE);
    expect(moved).toMatchObject({ action: 'install', content: loaderContent(SOURCE) });
    expect(planInstall(ORCA, SOURCE).action).toBe('skip');
    expect(planUninstall(undefined).action).toBe('none');
    expect(planUninstall(ORCA).action).toBe('skip');
    expect(planUninstall(loaderContent(SOURCE)).action).toBe('uninstall');
  });

  it('estado: ausente, atual, desatualizado, de outro', () => {
    expect(installState(undefined, SOURCE)).toBe('missing');
    expect(installState(loaderContent(SOURCE), SOURCE)).toBe('current');
    expect(installState(loaderContent('/x/habblaud.ts'), SOURCE)).toBe('outdated');
    expect(installState(ORCA, SOURCE)).toBe('foreign');
  });

  it('argumentos: comando, --dry-run, --port; porta do ambiente; erros', () => {
    expect(parseArgs(['install'], {})).toEqual({ command: 'install', dryRun: false, port: 4747 });
    expect(parseArgs(['status', '--dry-run', '--port', '5000'], {})).toEqual({ command: 'status', dryRun: true, port: 5000 });
    expect(parseArgs(['install'], { HABBLAUD_PORT: '4900' })).toMatchObject({ port: 4900 });
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs([], {})).toThrow(/install, uninstall ou status/);
    expect(() => parseArgs(['install', '--port', 'x'], {})).toThrow(/--port/);
    expect(() => parseArgs(['install', '--zzz'], {})).toThrow(/desconhecida/);
  });
});

describe('omp-install.ts (comando)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let agent: string;
  let extDir: string;
  let source: string;
  let out: string[];
  const env = () => ({ HABBLAUD_OMP_DIRS: agent }) as NodeJS.ProcessEnv;
  const opts = (command: RunOptions['command'], more: Partial<RunOptions> = {}): RunOptions => ({ command, dryRun: false, port: 4747, ...more });
  const exec = (command: RunOptions['command'], more: Partial<RunOptions> = {}, health?: Health, e: NodeJS.ProcessEnv = env()) =>
    run(opts(command, more), { env: e, home, source, out: (l) => out.push(l), health: async () => health });

  beforeEach(() => {
    tmp = tempDir('habblaud-omp-install-');
    home = join(tmp.dir, 'home');
    agent = join(home, '.omp', 'agent');
    extDir = join(agent, 'extensions');
    mkdirSync(join(agent, 'sessions'), { recursive: true });
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'orca-agent-status.ts'), ORCA);
    source = join(tmp.dir, 'repo', 'mod', 'habblaud-omp', 'habblaud.ts');
    out = [];
  });
  afterEach(() => tmp.cleanup());

  const orcaBytes = () => readFileSync(join(extDir, 'orca-agent-status.ts'));
  const installed = () => join(extDir, EXTENSION_FILE);

  it('instala só o loader e a porta; a extensão do Orca fica idêntica; reinstalar não duplica', async () => {
    const before = orcaBytes();
    expect(await exec('install', { port: 4850 })).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(loaderContent(source));
    expect(readdirSync(extDir).sort()).toEqual(['habblaud.ts', 'orca-agent-status.ts']);
    expect(readConfigPort(home)).toBe(4850);
    expect(orcaBytes().equals(before)).toBe(true);

    out = [];
    expect(await exec('install', { port: 4850 })).toBe(0);
    expect(out.join('\n')).toMatch(/já está instalada e atualizada/);
    expect(readdirSync(extDir).sort()).toEqual(['habblaud.ts', 'orca-agent-status.ts']);
    expect(orcaBytes().equals(before)).toBe(true);
  });

  it('cria extensions/ quando a pasta do omp ainda não tem', async () => {
    const bare = join(tmp.dir, 'outra', 'agent');
    mkdirSync(join(bare, 'sessions'), { recursive: true });
    expect(await exec('install', {}, undefined, { HABBLAUD_OMP_DIRS: bare })).toBe(0);
    expect(existsSync(join(bare, 'extensions', EXTENSION_FILE))).toBe(true);
  });

  it('atualiza o loader que aponta para outro lugar (repositório movido) sem duplicar', async () => {
    writeFileSync(installed(), loaderContent('/antigo/habblaud.ts'));
    expect(await exec('install')).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(loaderContent(source));
    expect(out.join('\n')).toMatch(/atualizada/);
  });

  it('uninstall apaga só o loader (e a porta fica); sem nada instalado termina sem erro', async () => {
    await exec('install', { port: 4851 });
    const before = orcaBytes();
    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(existsSync(installed())).toBe(false);
    expect(orcaBytes().equals(before)).toBe(true);
    expect(readConfigPort(home)).toBe(4851);
    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(out.join('\n')).toMatch(/não havia nada a remover/);
    expect(orcaBytes().equals(before)).toBe(true);
  });

  it('habblaud.ts que não é do Habblaud: nunca sobrescreve nem apaga (falha, arquivo intacto)', async () => {
    writeFileSync(installed(), 'export default function () {}\n');
    expect(await exec('install')).toBe(1);
    expect(await exec('uninstall')).toBe(1);
    expect(readFileSync(installed(), 'utf8')).toBe('export default function () {}\n');
  });

  it('--dry-run lista o que mudaria e não grava nada (nem a porta)', async () => {
    expect(await exec('install', { dryRun: true })).toBe(0);
    expect(existsSync(installed())).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
    expect(out.join('\n')).toMatch(/simulação[\s\S]*habblaud\.ts[\s\S]*porta 4747/);
    await exec('install');
    const bytes = readFileSync(installed());
    out = [];
    expect(await exec('uninstall', { dryRun: true })).toBe(0);
    expect(readFileSync(installed()).equals(bytes)).toBe(true);
    expect(out.join('\n')).toMatch(/apagaria/);
  });

  it('status: não instalada, instalada com o Habblaud respondendo, fora do ar, modo de decisão', async () => {
    expect(await exec('status')).toBe(0);
    expect(out.join('\n')).toMatch(/não instalada/);
    expect(out.join('\n')).toMatch(/fora do ar/);
    await exec('install', { port: 4852 });
    out = [];
    expect(await exec('status', { port: 4747 }, { ompEvents: true }, { ...env(), HABBLAUD_OMP_PERMISSOES: '1' })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/instalada e atualizada/);
    expect(text).toMatch(/Habblaud respondendo em http:\/\/127\.0\.0\.1:4852/);
    expect(text).toMatch(/PERMISSOES\): ligado/);
    out = [];
    await exec('status');
    expect(out.join('\n')).toMatch(/PERMISSOES\): desligado/);
  });

  it('status avisa de loader que aponta para arquivo que não existe mais', async () => {
    writeFileSync(installed(), loaderContent(join(tmp.dir, 'sumiu', 'habblaud.ts')));
    await exec('status');
    expect(out.join('\n')).toMatch(/aponta para .*sumiu.*não existe mais/);
  });

  it('sem pasta do omp: avisa e sai com 1', async () => {
    expect(await exec('install', {}, undefined, { HABBLAUD_OMP_DIRS: join(tmp.dir, 'nao-existe') })).toBe(1);
    expect(out.join('\n')).toMatch(/Nenhuma pasta do omp/);
  });
});
