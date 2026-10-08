import ts from "typescript"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
const root = process.cwd()
const groups = new Map<string, any[]>()
const stats: Record<string, any> = {}
function visit(dir: string) {
 for (const e of readdirSync(dir, {withFileTypes:true})) {
  const p=join(dir,e.name)
  if(e.isDirectory()){if(!["target","node_modules","dist","out"].includes(e.name))visit(p);continue}
  if(!p.endsWith('.ts') || /(?:\.test|\.generated)\.ts$/.test(p))continue
  const source=readFileSync(p,'utf8');const rel=p.slice(root.length+1);const pkg=rel.split('/')[1]!
  stats[pkg]??={files:0,lines:0,functions:0};stats[pkg].files++;stats[pkg].lines+=source.split('\n').length
  const sf=ts.createSourceFile(p,source,ts.ScriptTarget.Latest,true)
  function walk(n:ts.Node){
   if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n))&&n.body){
    stats[pkg].functions++
    const body=ts.createPrinter({removeComments:true}).printNode(ts.EmitHint.Unspecified,n.body,sf).replace(/\s+/g,' ')
    if(body.length>100){const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,body);const toks=[];let t;while((t=scanner.scan())!==ts.SyntaxKind.EndOfFileToken)toks.push(scanner.getTokenText());const key=toks.join(' ');const entry={file:rel,line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,name:(n as any).name?.getText(sf)??n.parent?.getText(sf).slice(0,70),length:body.length};groups.set(key,[...(groups.get(key)??[]),entry])}
   }
   ts.forEachChild(n,walk)
  };walk(sf)
 }
}
visit(join(root,'packages'))
const duplicates=[...groups.values()].filter(g=>g.length>1).sort((a,b)=>b[0].length-a[0].length)
await Bun.write('/tmp/hivecode-audit.json',JSON.stringify({stats,duplicates},null,2))
console.log(JSON.stringify({stats,duplicates:duplicates.slice(0,22)},null,2))
