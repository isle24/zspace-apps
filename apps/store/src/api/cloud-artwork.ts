export function cloudArtworkSources(icon:string,base='https://zstore.2iwm.com'):string[]{
 if(/^\/api\/cloud\/icons\/[a-f0-9]{64}$/.test(icon))return [base+icon,`https://raw.githubusercontent.com/isle24/nas-app-store-catalog/main/icons/${icon.split('/').pop()}.png`];
 try{const u=new URL(icon);if(u.protocol!=='https:'||u.username||u.password||!['raw.githubusercontent.com','github.com','cdn.jsdelivr.net','zstore.2iwm.com'].includes(u.hostname))return [];return u.hostname==='zstore.2iwm.com'?[icon]:[base+'/api/cloud/artwork?url='+encodeURIComponent(icon),icon]}catch{return []}
}
