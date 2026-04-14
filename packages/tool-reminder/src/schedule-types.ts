export type Schedule =
  | { kind: 'once'; at_iso: string }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day_of_month: number; hour: number; minute: number };
