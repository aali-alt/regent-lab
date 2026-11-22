import {createPasswordVerifier} from './auth-broker.mjs';
import {createServer} from 'node:http';
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {FirestoreRepository} from './firebase-repository.mjs';
import {createHandler} from './http-handler.mjs';
// No keys belong in source control. Use the host's secret store / application default credentials.
const projectId=process.env.FIREBASE_PROJECT_ID;
if(!projectId)throw new Error('FIREBASE_PROJECT_ID is required');
const app=initializeApp({projectId,credential:applicationDefault()});
const handler=createHandler({repo:new FirestoreRepository(getFirestore(app)),auth:getAuth(app),passwordVerifier:createPasswordVerifier({apiKey:process.env.FIREBASE_WEB_API_KEY,projectId}),allowedOrigin:process.env.ALLOWED_ORIGIN});
createServer(handler).listen(Number(process.env.PORT)||8080);
