// Firebase Configuration and Modular SDK Exports for Beach'n Bagels
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  addDoc, 
  updateDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  onSnapshot, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAEOwp0RdxMkxXdBx6yJlhPhoXq6Vbi3Do",
  authDomain: "beachnbagels.firebaseapp.com",
  projectId: "beachnbagels",
  storageBucket: "beachnbagels.firebasestorage.app",
  messagingSenderId: "697659238755",
  appId: "1:697659238755:web:58ebee2e4195cdc8744b56",
  measurementId: "G-QWJ8540ZXF"
};

// Initialize Firebase App & Firestore
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { 
  app, 
  db, 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  addDoc, 
  updateDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  onSnapshot, 
  serverTimestamp 
};
