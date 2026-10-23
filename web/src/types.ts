export type Role = 'manager' | 'floor' | 'kitchen';
export type ItemStatus = 'new' | 'preparing' | 'ready' | 'served' | 'void';
export interface Me {
  user: { id: string; name: string; role: Role; branchId: string | null };
  restaurant: { id: string; name: string; servicePct: number; vatPct: number; floorDiscountMaxPct: number };
  branches: { id: string; name: string }[];
}
export interface OrderItem {
  id: string; menuItemId: string; name: string; unitPrice: number; station: 'kitchen' | 'bar'; qty: number; note: string | null;
  status: ItemStatus; version: number; round: number; createdAt: string; statusAt: string; voidReason: string | null;
}
export interface Totals { subtotal: number; discount: number; service: number; vat: number; total: number }
export interface Order {
  id: string; branchId: string; tableId: string | null; tableLabel: string | null; tableZone: string | null; kind: 'dine_in' | 'takeaway'; number: number;
  status: 'open' | 'paid' | 'void'; guests: number; openedAt: string; closedAt: string | null; openedByName: string; billRequestedAt: string | null;
  discount: { kind: 'percent' | 'amount'; value: number; reason: string | null } | null; version: number; floorDiscountMaxPct: number;
  items: OrderItem[]; payments: { id: string; method: 'cash' | 'card' | 'transfer'; amount: number; createdAt: string; byName: string }[];
  totals: Totals; paidAmount: number; remaining: number;
}
export interface FloorOrder { id: string; number: number; guests: number; openedAt: string; billRequestedAt: string | null; counts: { new: number; preparing: number; ready: number; served: number }; total: number }
export interface FloorTable { id: string; label: string; zone: string; seats: number; order: FloorOrder | null }
export interface MenuItem { id: string; name: string; description: string | null; price: number; station: 'kitchen' | 'bar'; prepMinutes: number; available: boolean }
export interface MenuCategory { id: string; name: string; icon: string | null; items: MenuItem[] }
export interface KitchenItem {
  id: string; orderId: string; name: string; qty: number; note: string | null; status: ItemStatus; version: number; station: 'kitchen' | 'bar';
  round: number; createdAt: string; statusAt: string; orderNumber: number; kind: 'dine_in' | 'takeaway'; tableLabel: string | null; tableZone: string | null;
}

export interface AdminTable { id: string; label: string; zone: string; seats: number; sort: number; active: boolean; busy: boolean }
