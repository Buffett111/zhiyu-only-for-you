export const CHANNEL_CATEGORIES=['音樂','遊戲','運動','科技','財經與商業','知識與教育','新聞與公共議題','電影與動漫','生活與娛樂','旅遊與戶外','飲食','藝術與文化','其他','無法判斷'] as const;
export type ChannelCategory=typeof CHANNEL_CATEGORIES[number];
export interface MediaChannel {
 key:string;name:string;iconUrl:string|null;url:string|null;estimatedSeconds:number|null;timedEvents:number;count:number;videos:number;share:number;
 category:string;confidence:number|null;source:string;reviewed:boolean;curatorTags:string[];
 evidence:{id:string;title:string;quote:string}[];generatedAt:string|null;
}
export interface ChannelOverview {
 items:MediaChannel[];hasMore:boolean;totalChannels:number;selected:number;identified:number;categorized:number;
 categories:{name:string;count:number;channels:number}[];
 curator:{available:boolean;sourceTime:string|null;fetchedAt:string|null;version:string|null;groups:{name:string;count:number}[]};
 metadata:{total:number;ready:number;unavailable:number;errors:number;pending:number;perMinute:number;estimatedMinutes:number|null;batchSize:number;concurrency:number};
 processing:{autoClassify:boolean;status:string;error:string|null;lastSuccess:string|null;dailyBatches:number;dailyLimit:number;batchSize:number;concurrency:number;activeBatches:number};
}
