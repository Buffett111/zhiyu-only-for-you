export interface MediaEvent {eventId:string;videoId:string|null;title:string;channel:string|null;watchedAt:string;actualSeconds:number|null;precision:'day'|'exact';topics:string[];topicSource:string|null;source:string;}
export interface MediaRanking {name:string;count:number;share:number;previousCount:number;}
export interface MediaSummary {
 range:string;total:number;selected:number;uniqueVideos:number;activeDays:number;recordedSeconds:number|null;timedEvents:number;
 from:string|null;to:string|null;channels:MediaRanking[];topics:MediaRanking[];classifiedEvents:number;
 daily:{date:string;count:number}[];hourly:{hour:number;count:number}[];
 imports:{source:string;inserted:number;skipped:number;importedAt:string}[];
 aiEnabled:boolean;unclassifiedVideos:number;
}
