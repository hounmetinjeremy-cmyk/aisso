import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { isSupported, getAnalytics } from 'firebase/analytics';

// Projet Firebase dédié à Aïsso (distinct de celui de Center) — comptes propres à l'app.
const firebaseConfig = {
  apiKey: 'AIzaSyC0YIPr2zA6l1F4Rdo4Pj6NxhMOTI0UkFw',
  authDomain: 'aisso-d9de3.firebaseapp.com',
  projectId: 'aisso-d9de3',
  storageBucket: 'aisso-d9de3.firebasestorage.app',
  messagingSenderId: '545417768480',
  appId: '1:545417768480:web:c38ab7702be2fc05669645',
  measurementId: 'G-3QLJRGX6WH',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Analytics : uniquement si le navigateur le supporte (absent en SSR / certains webviews).
isSupported()
  .then((supported) => {
    if (supported) {
      getAnalytics(app);
    }
  })
  .catch(() => {});
