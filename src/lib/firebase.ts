import { initializeApp, getApps } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDbu6XA0fqaA7pnSZz0eVJlq3WMWrq6Je8",
  authDomain: "dm-battle-app.firebaseapp.com",
  databaseURL: "https://dm-battle-app-default-rtdb.firebaseio.com",
  projectId: "dm-battle-app",
  storageBucket: "dm-battle-app.firebasestorage.app",
  messagingSenderId: "313162271546",
  appId: "1:313162271546:web:dfe528b5fa491dad4e5e03",
  measurementId: "G-R4CR361T6F"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getDatabase(app);