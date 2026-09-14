// Preserve missing values and positive short durations throughout the UI.
export function formatMediaDuration(seconds:number|null|undefined):string{
 if(seconds==null||!Number.isFinite(seconds)||seconds<0)return '時長未知';
 if(seconds===0)return '0 秒';
 if(seconds<1)return '不到 1 秒';
 const whole=Math.floor(seconds),minutes=Math.floor(whole/60),remainder=whole%60;
 if(whole<60)return `${whole} 秒`;
 if(whole<3600)return `${minutes} 分鐘${remainder?` ${remainder} 秒`:''}`;
 const hours=Math.floor(minutes/60),remainingMinutes=minutes%60;
 return `${hours.toLocaleString('zh-TW')} 小時${remainingMinutes?` ${remainingMinutes} 分鐘`:''}`;
}
export function formatMediaProgress(percent:number):string{
 if(percent>0&&percent<.1)return '<0.1%';
 return `${Number(percent.toFixed(1))}%`;
}
