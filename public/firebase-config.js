// Public web config. These values identify the project and are safe to ship; access is enforced by auth and Firestore rules.
export const firebaseConfig = {
  apiKey: "AIzaSyAvqhKD02rxIOHUTSS45jq_SD3Gjg4PoCE",
  authDomain: "home-energy-n0u5x.firebaseapp.com",
  projectId: "home-energy-n0u5x",
  storageBucket: "home-energy-n0u5x.firebasestorage.app",
  messagingSenderId: "745136819982",
  appId: "1:745136819982:web:4dffa8e8bb647f211b915f",
};

// Where the Cloudflare Worker lives. Set after worker:deploy.
export const API_URL = "https://home-energy-api.adeleke-tolu.workers.dev";

