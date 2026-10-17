import {
  ArrowLeftRight, BadgeCheck, Compass, DatabaseBackup, BadgeDollarSign, Banknote, BookOpen, Building2, ChartColumn, Download, Ellipsis, FileText, GraduationCap,
  House, KeyRound, Landmark, Lock, Receipt, Repeat, ScrollText, Settings, Target, Upload, UserCog, Users, Wallet, Wand2,
} from 'lucide-react';

// One icon per area of the app, used by the side navigation, page headers and Main Menu tiles.
// Longest matching path prefix wins.
const ROUTE_ICONS = [
  ['/guide', Compass],
  ['/income', BadgeDollarSign],
  ['/deposits', Banknote],
  ['/expenses', Receipt],
  ['/bills/pay', Wallet],
  ['/bills', FileText],
  ['/companies', Users],
  ['/register/transfers', ArrowLeftRight],
  ['/register', BookOpen],
  ['/reconcile', BadgeCheck],
  ['/bank-feed/setup', Settings],
  ['/bank-feed/rules', Wand2],
  ['/bank-feed', Repeat],
  ['/reports', ChartColumn],
  ['/budgets', Target],
  ['/setup', Landmark],
  ['/tuition', GraduationCap],
  ['/advanced/journal-entries', ScrollText],
  ['/advanced/period-closing', Lock],
  ['/advanced/backup', DatabaseBackup],
  ['/advanced/import', Upload],
  ['/advanced/quickbooks-files', Download],
  ['/advanced', Ellipsis],
  ['/users', UserCog],
  ['/settings', Settings],
  ['/account', KeyRound],
  ['/admin/organizations', Building2],
  ['/print', FileText],
];

export function iconFor(path) {
  if (!path || path === '/') return House;
  let best = null;
  for (const [prefix, icon] of ROUTE_ICONS) {
    if ((path === prefix || path.startsWith(`${prefix}/`)) && (!best || prefix.length > best[0].length)) best = [prefix, icon];
  }
  return best ? best[1] : null;
}
