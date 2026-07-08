import {
  BarChart3,
  BookOpen,
  Inbox,
  Landmark,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/books', label: 'Books', Icon: BookOpen },
  { to: '/bank', label: 'Bank', Icon: Landmark },
  { to: '/reports', label: 'Reports', Icon: BarChart3 },
  { to: '/settings', label: 'Settings', Icon: Settings },
];
