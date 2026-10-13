import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const read=(name:string)=>readFileSync(new URL(name,import.meta.url),'utf8');
const css=read('./fnos-theme.css');
function declarations(block:string){return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m=>[m[1],m[2].trim()]))}
const light=declarations(css.match(/:root\s*\{([^}]+)\}/)![1]);
const dark={...light,...declarations(css.match(/:root\[data-theme="dark"\][^{]+\{([^}]+)\}/)![1])};
function resolved(value:string,palette:Record<string,string>):string{const v=value.match(/^var\((--[\w-]+)(?:,\s*(.*))?\)$/);return v?resolved(palette[v[1]]??v[2]??'#fff',palette):value}
function rgb(value:string):number[]{if(value.startsWith('#')){const hex=value.slice(1);return (hex.length===3?[...hex].map(c=>c+c):hex.match(/../g)!).map(c=>parseInt(c,16))};const v=value.match(/rgba?\(([^)]+)\)/);if(!v)throw Error('Unsupported palette color '+value);return v[1].split(',').map(Number)}
function over(color:number[],bg:number[]){return color.slice(0,3).map((c,i)=>c*(color[3]??1)+bg[i]*(1-(color[3]??1)))}
function luminance(color:number[]){return color.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0)}
function contrast(text:string,background:string,palette:Record<string,string>){const bg=rgb(resolved(background,palette));const fg=over(rgb(resolved(text,palette)),bg);const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}
function ruleColor(file:string,selector:string,property:string){
 const text=read(file).replace(/\/\*[\s\S]*?\*\//g,'');const results:string[]=[];
 for(const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  if(!match[1].trim().split(',').map(v=>v.trim()).includes(selector))continue;
  const value=match[2].match(new RegExp('(?:^|;)\\s*'+property+':\\s*([^;]+)'))?.[1];if(value)results.push(value.trim());
 }
 expect(results.length,'missing '+property+' style for '+selector).toBeGreaterThan(0);return results[results.length-1]
}
it('resolves the existing photo, notes and compose surfaces to dark surfaces instead of white fallbacks',()=>{
 for(const [file,selector] of [['./fnos-management.css','.photos-workspace'],['./fnos-management.css','.compose-dialog textarea'],['./nas-tools.css','.nas-tool-card']] as const){const background=ruleColor(file,selector,'background');expect(luminance(rgb(resolved(background,dark))),selector+' dark surface').toBeLessThan(0.12)}
});
it('keeps small secondary text and danger messages readable on the active content surface in both themes',()=>{
 for(const palette of [light,dark])for(const text of ['var(--fn-text-3)','var(--fn-danger)'])expect(contrast(text,'var(--fn-window-surface)',palette),text+' contrast').toBeGreaterThanOrEqual(4.5)
});
it('keeps the login password readable when the saved desktop appearance is dark',()=>{
 const background=ruleColor('./fnos-shell.css','.login-screen .login-card .password-field','background');
 expect(contrast('var(--fn-text-0)',background,dark)).toBeGreaterThanOrEqual(4.5)
});
it('keeps inherited window text readable when a module does not set its own foreground',()=>{
 const foreground=ruleColor('../styles.css','.app-window','color');
 expect(contrast(foreground,'var(--fn-window-surface)',dark)).toBeGreaterThanOrEqual(4.5)
});
