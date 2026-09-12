export type Market = 'TWSE' | 'TPEx';
export type AssetType = 'stock' | 'etf';
export interface User { id: string; email: string; displayName: string; role: 'admin' | 'member'; }
export interface WidgetDefinition { id: string; name: string; description: string; }
export interface ModuleDefinition { id: string; name: string; description: string; version: string; configVersion: number; icon: string; widgets: WidgetDefinition[]; routes: string[]; jobs: string[]; }
export interface ModuleState { moduleId: string; enabled: boolean; configVersion: number; config: Record<string, unknown>; widgets: string[]; }
export interface Security { id: string; symbol: string; name: string; market: Market; assetType: AssetType; currency: 'TWD'; sector?: string; aliases: string[]; sourceUrl: string; active?: boolean; }
export interface Quote { securityId: string; date: string; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; change: number | null; changePercent: number | null; source: string; fetchedAt: string; priceType: 'eod'; dataset?: 'snapshot' | 'history'; volumePrecision?: 'shares' | 'thousand_shares'; status: 'traded' | 'no_trade' | 'suspended'; }
export interface Fundamentals { securityId: string; asOf: string; revenuePeriod: string | null; earningsPeriod: string | null; basis: 'cumulative' | 'quarter' | 'annual'; revenue: number | null; revenueYoy: number | null; eps: number | null; grossMargin: number | null; operatingMargin: number | null; unit: string; sourceUrl: string; sourceUrls?: string[]; fetchedAt?: string; availability: 'available' | 'not_applicable' | 'unsupported' | 'missing'; }
export interface NewsItem { id: string; title: string; url: string; publishedAt: string; source: string; kind: 'news' | 'announcement'; securityIds: string[]; matchType: 'exact' | 'market'; }
export interface WatchlistEntry { securityId: string; held: boolean; interested: boolean; group: string; createdAt: string; security: Security; quote: Quote | null; }
export interface SourceStatus { id: string; name: string; status: 'pending' | 'success' | 'partial' | 'error'; lastAttempt: string | null; lastSuccess: string | null; dataDate: string | null; error: string | null; count: number; }
export interface Digest { date: string; generatedAt: string; title: string; summary: string; tracked: number; up: number; down: number; unchanged: number; missing: number; items: { securityId?: string; title: string; body: string; url?: string }[]; partial: boolean; read: boolean; }
export interface HistoryResponse { quotes: Quote[]; coverage: { from: string | null; to: string | null; requestedFrom: string; partial: boolean }; status: 'ready' | 'pending' | 'partial'; }
export interface SecurityDetail { security: Security; quote: Quote | null; fundamentals: Fundamentals; news: NewsItem[]; }
export interface BootstrapResponse { user: User; modules: ModuleDefinition[]; states: ModuleState[]; watchlist: WatchlistEntry[]; digest: Digest | null; sources: SourceStatus[]; mode: 'development' | 'production'; }
export interface ProviderResult<T> { items: T[]; dataDate?: string; warnings: string[]; }
export interface MarketSnapshot { securities: Security[]; quotes: Quote[]; dataDate: string; warnings: string[]; }
