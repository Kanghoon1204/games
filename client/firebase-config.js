// Firebase 설정 (flowmate-44103)
const firebaseConfig = {
  apiKey: 'AIzaSyAgMNqCCyBRtUB5MGC_eqSaNtRPhu4dDrw',
  authDomain: 'flowmate-44103.firebaseapp.com',
  databaseURL: 'https://flowmate-44103-default-rtdb.asia-northeast3.firebasedatabase.app',
  projectId: 'flowmate-44103',
  storageBucket: 'flowmate-44103.firebasestorage.app',
  messagingSenderId: '568897518912',
  appId: '1:568897518912:web:950b5194188e6aed538ea5'
};

// Firebase 초기화
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
