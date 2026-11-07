/** Only explicit, bounded setup observations become check receipts. */
export function setupEvidence(texts: readonly (string | null | undefined)[]) {
  const result: { os: string | null; node: string | null; git: string | null; github: "ok" | "failed" | null } = {os:null,node:null,git:null,github:null};
  for (const text of texts) {
    for (const match of (text ?? "").slice(-32000).matchAll(/=== SETUP CHECK ===\s*([\s\S]*?)(?:=== END SETUP CHECK ===|$)/g)) {
      const block = match[1]!.slice(0,1000);
      const field = (name:string) => new RegExp(`^${name}:\\s*([^\\r\\n]{1,100})$`,"m").exec(block)?.[1]?.trim() ?? null;
      const os=field("OS"),node=field("NODE"),git=field("GIT"),github=field("GITHUB");
      if(os && /^[\w .()/-]+$/.test(os))result.os=os;
      if(node && /^v?\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?$/.test(node))result.node=node.replace(/^v/,"");
      if(git && /^\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?$/.test(git))result.git=git;
      if(github==="ok"||github==="failed")result.github=github;
    }
  }
  return result;
}

export function setupDuration(createdAt:string,finishedAt:string|null,now:number) {
  const seconds=Math.floor(((finishedAt?Date.parse(finishedAt):now)-Date.parse(createdAt))/1000);
  return Number.isFinite(seconds)&&seconds>=0?seconds>=60?`${Math.floor(seconds/60)} min ${seconds%60} s`:`${seconds} s`:null;
}
