import React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, KeyRound, LogOut, Settings, UserRound } from 'lucide-react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { iconFor } from '../icons.js';

export const NAV = [
  { to: '/guide', label: 'Guide Me' },
  { to: '/income', label: 'Deposits & Income', also: ['/deposits'] },
  { to: '/expenses', label: 'Expenses' },
  { to: '/bills', label: 'Bills' },
  { to: '/companies', label: 'Customers, Donors & Vendors' },
  { to: '/register', label: 'Bank Registers' },
  { to: '/reconcile', label: 'Reconcile Accounts' },
  { to: '/bank-feed', label: 'Bank Feeds' },
  { to: '/reports', label: 'Reports' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/setup', label: 'Accounts & Funds' },
  { to: '/tuition', label: 'Tuition', feature: 'tuition_enabled' },
  { to: '/advanced', label: 'Advanced' },
  { to: '/users', label: 'User Setup', admin: true },
];

const NavIcon = ({ to }) => {
  const Icon = iconFor(to);
  return <span className="nav-ico">{Icon && <Icon size={18} strokeWidth={2} aria-hidden="true" />}</span>;
};

export default function Layout({ bare, children }) {
  const { me, isOrgAdmin } = useApp();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = '/';
  };
  const org = me.currentOrganization;
  return (
    <div className={`shell${bare ? ' shell-bare' : ''}`}>
      <header className="topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}>
          <span className="brand-mark"><img src="/logo-mark.png" alt="" /></span>
          <span className="brand-text">The Faithful Steward</span>
        </button>
        {org && (
          <div className="org-name">
            {org.name}
            {me.organizations.length > 1 && <button type="button" className="link small" onClick={() => navigate('/select-org')}>Switch</button>}
          </div>
        )}
        <div className="topbar-right">
          <details className="user-menu">
            <summary><UserRound size={17} aria-hidden="true" /><span>{me.user.display_name}</span><ChevronDown size={16} className="user-caret" aria-hidden="true" /></summary>
            <div className="user-menu-pop" onClick={(e) => e.currentTarget.parentElement.removeAttribute('open')}>
              <NavLink to="/account"><KeyRound size={16} aria-hidden="true" />My account &amp; connected apps</NavLink>
              {org && isOrgAdmin && <NavLink to="/settings"><Settings size={16} aria-hidden="true" />Organization settings</NavLink>}
              {me.user.is_system_admin && <NavLink to="/admin/organizations"><Building2 size={16} aria-hidden="true" />Manage organizations</NavLink>}
              <button type="button" className="link" onClick={logout}><LogOut size={16} aria-hidden="true" />Sign out</button>
            </div>
          </details>
        </div>
      </header>
      <div className="body">
        {!bare && (
          <nav className="sidenav" aria-label="Main">
            <NavLink to="/" end className="navlink"><NavIcon to="/" />Main Menu</NavLink>
            {NAV.filter((n) => (!n.admin || isOrgAdmin) && (!n.feature || org?.[n.feature])).map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => `navlink${isActive || n.also?.some((p) => pathname.startsWith(p)) ? ' active' : ''}`}>
                <NavIcon to={n.to} />{n.label}
              </NavLink>
            ))}
          </nav>
        )}
        <main className="main">{children || <Outlet />}</main>
      </div>
    </div>
  );
}
