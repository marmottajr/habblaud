// Pedidos de aprovação do Kiro CLI (hook PreToolUse de mod/habblaud-kiro/approval-hook.mjs): título, resumo e
// argumentos pelos nomes de ferramenta do Kiro (2.x: execute_bash; 3.x: shell; fs_write/fs_read etc.). O resumo e o
// ícone vêm do mesmo tradutor da fonte do Kiro (server/sources/kiro/parser.ts); os argumentos, mascarados e cortados
// como no terminal:
// - shell/execute_bash/...: {command, summary?|__tool_use_purpose?} -> vai como comando ("$ …");
// - fs_write/write: criar/editar arquivo -> vai como diff (texto novo), igual ao Write/Edit;
// - outras: o JSON dos argumentos (ou o começo), como o terminal mostra.
import { describeKiroTool, KIRO_SHELL_TOOLS } from '../sources/kiro/parser';
import { toolView } from '../sources/terminal';
import type { TerminalInputKind } from '../../shared/types';

/** Resumo de um pedido do Kiro: o que vai em PermissionRequestInfo (title, text, icon, input, inputKind). */
export interface KiroToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

type Rec = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Nome de ferramenta do Claude Code equivalente, para reaproveitar o toolView (título + prévia). */
function claudeName(tool: string, input: Rec): string | undefined {
  if (KIRO_SHELL_TOOLS.has(tool)) return 'Bash';
  // 3.x: str_replace {path, old_str, new_str} = edição (diff do trecho).
  if (tool === 'str_replace') return 'Edit';
  // Edição/escrita de arquivo (2.x: write com command create|strReplace; 3.x: fs_write com path+text).
  if (/^(write|fs_write|write_file)$/.test(tool)) return 'Write';
  if (/^(read|fs_read|read_file)$/.test(tool)) return 'Read';
  void input;
  return undefined;
}

/** Título, resumo e argumentos de um pedido do Kiro. */
export function kiroToolView(tool: string, input: Rec, cwd?: string): KiroToolView {
  const desc = describeKiroTool(tool, input);
  // shell: o comando vai inteiro na caixa "$ …" (é o que se aprova).
  if (KIRO_SHELL_TOOLS.has(tool)) {
    const command = str(input.command) ?? '';
    const view = toolView('Bash', { command }, cwd);
    return { title: view.title, text: desc.text, icon: desc.icon, ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}) };
  }
  const name = claudeName(tool, input);
  if (name) {
    // fs_write (3.x): {path, text}; write (2.x): {path, file_text|new_str}. Normaliza para o Write/Edit do Claude.
    const mapped: Rec = { ...input };
    if (name === 'Write') {
      if (mapped.file_path === undefined) mapped.file_path = input.path;
      if (mapped.content === undefined) mapped.content = str(input.text) ?? str(input.file_text) ?? str(input.new_str) ?? str(input.command);
    } else if (name === 'Read') {
      if (mapped.file_path === undefined) mapped.file_path = input.path;
    } else if (name === 'Edit') {
      if (mapped.file_path === undefined) mapped.file_path = input.path;
      if (mapped.old_string === undefined) mapped.old_string = str(input.old_str) ?? '';
      if (mapped.new_string === undefined) mapped.new_string = str(input.new_str) ?? '';
    }
    const view = toolView(name, mapped, cwd);
    return { title: view.title, text: desc.text, icon: desc.icon, ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}) };
  }
  // Qualquer outra ferramenta: o título e a prévia genéricos do terminal, com o resumo/ícone do Kiro.
  const view = toolView(tool, input, cwd);
  return { title: view.title, text: desc.text, icon: desc.icon, ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}) };
}
