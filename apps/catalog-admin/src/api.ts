import {CloudCatalog} from '../../store/src/api/cloud-catalog';
export {type CloudApp,type CloudUser,type Wish} from '../../store/src/api/cloud-catalog';
export const adminApi=new CloudCatalog(location.origin);
