import type { CategoryNode, ScheduledEvent } from '@hearth/core';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'Request failed');
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export interface Me { id: string; name: string; householdId: string; mustChangePassword: boolean }
export interface BudgetView { month: string; income: number; plannedTotal: number; spentTotal: number; leftToAssign: number; tree: CategoryNode[] }
export interface Txn { id: string; date: string; amount_cents: number; merchant: string; category_id: string | null; category_name: string | null; source: string; note: string | null }
export interface CalendarView { month: string; events: ScheduledEvent[] }
export interface PlanRun { strategy: 'snowball' | 'avalanche'; months: number; doneLabel: string; totalInterest: number; paidOff: Record<string, string>; order: string[]; incomplete: boolean }
export interface IncomeEvent { id: string; name: string; kind: 'one_time' | 'raise'; month: string; amount_cents: number; destination: 'loans' | 'emergency' | 'split'; enabled: boolean; repeats_yearly: boolean; note: string | null }
export interface Goal { id: string; name: string; kind: 'save' | 'debt'; target_cents: number; saved_cents: number; monthly_cents: number; target_month: string | null; horizon: string | null; etaLabel: string }
export interface PlanView {
  startMonth: string; strategy: 'snowball' | 'avalanche'; extraCents: number;
  loans: { id: string; name: string; balance: number; apr: number; minPayment: number }[];
  current: PlanRun; withoutIncome: PlanRun; snowball: PlanRun; avalanche: PlanRun;
  minimumsOnly: { doneLabel: string; totalInterest: number };
  incomeEvents: IncomeEvent[]; goals: Goal[];
}
