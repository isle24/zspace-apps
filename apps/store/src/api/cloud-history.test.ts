import {afterEach,expect,it,vi} from 'vitest';
import {trackCloudInstallHistory} from './cloud-history';
import {cloud} from './cloud-catalog';
import {api} from './client';
import type {RuntimePlan} from '../modules/runtime-types';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()});
it('records only a completed NAS install, using a nickname instead of its private IP',async()=>{
 vi.useFakeTimers();vi.spyOn(cloud,'signedIn','get').mockReturnValue(true);
 const read=vi.spyOn(api,'store').mockResolvedValueOnce({items:[{id:'job',planId:'history-one',status:'running'}]}).mockResolvedValueOnce({items:[{id:'job',planId:'history-one',status:'succeeded'}]});
 const save=vi.spyOn(cloud,'request').mockResolvedValue({});
 trackCloudInstallHistory([{id:'history-one',kind:'install',appId:'cloud-reader',targetVersion:'1.0.0'} as RuntimePlan]);
 await vi.advanceTimersByTimeAsync(0);expect(save).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(2500);expect(read).toHaveBeenCalledTimes(2);
 expect(save).toHaveBeenCalledWith('history',{appId:'reader',version:'1.0.0',status:'installed',deviceName:'我的 NAS'});
});
it('does not attribute a completed installation to a replacement cloud account',async()=>{
 vi.useFakeTimers();vi.spyOn(cloud,'signedIn','get').mockReturnValue(true);let generation=1;
 vi.spyOn(cloud,'generation','get').mockImplementation(()=>generation);
 vi.spyOn(api,'store').mockImplementation(async()=>{generation=2;return {items:[{planId:'history-two',status:'succeeded'}]} as never});
 const save=vi.spyOn(cloud,'request').mockResolvedValue({});
 trackCloudInstallHistory([{id:'history-two',kind:'install',appId:'reader',targetVersion:'1.0.0'} as RuntimePlan]);
 await vi.advanceTimersByTimeAsync(0);expect(save).not.toHaveBeenCalled();
});
it('retains the real catalog id when the local runtime id is shortened',async()=>{
 vi.useFakeTimers();vi.spyOn(cloud,'signedIn','get').mockReturnValue(true);
 vi.spyOn(api,'store').mockResolvedValue({items:[{planId:'history-long',status:'succeeded'}]});
 const save=vi.spyOn(cloud,'request').mockResolvedValue({});const id='a'.repeat(64);
 trackCloudInstallHistory([{id:'history-long',kind:'install',appId:'cloud-aabbcc',targetVersion:'1.0.0'} as RuntimePlan],{'history-long':id});
 await vi.advanceTimersByTimeAsync(0);expect(save).toHaveBeenCalledWith('history',expect.objectContaining({appId:id}));
});
