import { registerRootComponent } from 'expo';

// Arka plan görevi, uygulama bileşeninden önce tanımlanmalı
import './src/tasks';
import App from './App';

registerRootComponent(App);
