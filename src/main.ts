import './styles.css';
import { el } from './ui/dom';
import { route, startRouter } from './router';
import { homeScreen } from './ui/screens/home';
import { calibrateScreen } from './ui/screens/calibrate';
import { sessionScreen } from './ui/screens/session';
import { reportScreen } from './ui/screens/report';
import { historyScreen } from './ui/screens/history';
import { settingsScreen } from './ui/screens/settings';

const app = document.getElementById('app')!;

const nav = el('nav', { class: 'tabs' },
  el('a', { href: '#/', 'data-tab': 'home' }, 'Sit'),
  el('a', { href: '#/history', 'data-tab': 'history' }, 'History'),
  el('a', { href: '#/settings', 'data-tab': 'settings' }, 'Settings'),
);

const mount = el('div');
app.append(nav, mount);

route(/^#\/$/, homeScreen, 'home');
route(/^#\/calibrate$/, calibrateScreen, 'home');
// The session route passes no tab, which hides the nav for the duration.
route(/^#\/session$/, sessionScreen, null);
route(/^#\/report\/(.+)$/, reportScreen, 'history');
route(/^#\/history$/, historyScreen, 'history');
route(/^#\/settings$/, settingsScreen, 'settings');

startRouter(mount, nav);
