// agent 注册表与「已安装」判定。
//
// 为什么需要它：用户抱怨「没安装的 agent 也显示」。而 magpie 支持的 63 个 agent
// 各自把数据放在固定目录里——目录在，就说明装过；目录里有近期文件，就说明在跑。
// 这份表给出「id → 名称 / 数据目录 / 转录 glob」，用磁盘事实代替猜测。
//
// 注意边界：这里的「已安装」= 该 agent 的数据目录存在。它不等于「可交互」——
// 能列会话/能发消息仍取决于我们是否有它的转录解析器（claude/codex/dsh/antigravity 四种）。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function homeDir() {
  return process.env.MAGPIE_AGENTS_HOME || homedir();
}

// id → { name, dirs: [相对 home 的目录], transcripts?: [相对目录的 glob 片段] }
// 只收「目录位置确定」的；不确定的不写进来，宁缺不猜。
export const AGENTS = {
  claude: { name: "Claude Code", dirs: [".claude"], transcripts: [".claude/projects"] },
  "claude-desktop": { name: "Claude Desktop", dirs: ["Library/Application Support/Claude", "AppData/Roaming/Claude"] },
  codex: { name: "Codex", dirs: [".codex"], transcripts: [".codex/sessions"] },
  dsh: { name: "DeepSeek Harness", dirs: [".dsh"], transcripts: [".dsh/sessions"] },
  antigravity: { name: "Antigravity", dirs: [".gemini/antigravity", ".gemini"] },
  agy: { name: "Antigravity CLI", dirs: [".gemini/antigravity-cli"] },
  gemini: { name: "Gemini CLI", dirs: [".gemini"] },
  cursor: { name: "Cursor", dirs: [".cursor", "AppData/Roaming/Cursor"] },
  copilot: { name: "Copilot CLI", dirs: [".copilot", ".config/github-copilot"] },
  cline: { name: "Cline", dirs: [".cline", "Documents/Cline"] },
  kimi: { name: "Kimi Code", dirs: [".kimi"] },
  "kimi-code-desktop": { name: "Kimi Code Desktop", dirs: [".kimi-desktop", "AppData/Roaming/Kimi"] },
  qwen: { name: "Qwen Code", dirs: [".qwen"] },
  zed: { name: "Zed", dirs: [".zed", "AppData/Roaming/Zed"] },
  crush: { name: "Crush", dirs: [".crush", ".config/crush"] },
  goose: { name: "Goose", dirs: [".goose", ".config/goose"] },
  continue: { name: "Continue", dirs: [".continue"] },
  aider: { name: "Aider", dirs: [".aider"] },
  opencode: { name: "OpenCode", dirs: [".opencode", ".local/share/opencode", "AppData/Roaming/opencode"] },
  amp: { name: "Amp", dirs: [".amp"] },
  kiro: { name: "Kiro", dirs: [".kiro", "AppData/Roaming/Kiro"] },
  trae: { name: "TRAE", dirs: [".trae", "AppData/Roaming/Trae"] },
  qoder: { name: "Qoder", dirs: [".qoder", "AppData/Roaming/Qoder"] },
  windsurf: { name: "Windsurf", dirs: [".codeium", ".windsurf", "AppData/Roaming/Windsurf"] },
  roo: { name: "Roo Code", dirs: [".roo"] },
  devin: { name: "Devin", dirs: [".devin"] },
  droid: { name: "Droid", dirs: [".factory", ".droid"] },
  kirocrew: { name: "Kiro Crew", dirs: [".kirocrew"] },
  openclaw: { name: "OpenClaw", dirs: [".openclaw"] },
  magpie: { name: "magpie", dirs: [".config/magpie"] },
};

const RECENT_MS = 7 * 86_400_000;

function newestUnder(dir, depth = 3) {
  let newest = 0;
  const walk = (d, level) => {
    if (level > depth) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const st = statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (e.isDirectory()) walk(p, level + 1);
      } catch { /* 无权限等，跳过 */ }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * 本机各 agent 的安装与活动情况。
 * @returns {Array<{id, name, installed, dir, lastActiveMs, active}>}
 */
export function detectAgents() {
  const home = homeDir();
  const now = Date.now();
  const out = [];
  for (const [id, spec] of Object.entries(AGENTS)) {
    let foundDir = null;
    for (const rel of spec.dirs) {
      const p = join(home, rel);
      if (existsSync(p)) { foundDir = p; break; }
    }
    const lastActiveMs = foundDir ? newestUnder(foundDir) : 0;
    out.push({
      id,
      name: spec.name,
      installed: !!foundDir,
      dir: foundDir,
      lastActiveMs: lastActiveMs || null,
      active: !!lastActiveMs && now - lastActiveMs < RECENT_MS,
      transcripts: spec.transcripts ?? [],
    });
  }
  return out.sort((a, b) => (Number(b.installed) - Number(a.installed)) || a.name.localeCompare(b.name));
}

export function agentName(id) {
  return AGENTS[id]?.name ?? id;
}