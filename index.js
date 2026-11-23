import 'dotenv/config';
import dotenv from 'dotenv';
import express from 'express';
import {initializeApp, cert} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {createRequire} from 'module';

dotenv.config({path: './cred.env'});

const require = createRequire(import.meta.url);
const webpush = require('web-push');

//Carica le credenziali
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./serviceAccountKey.json');

initializeApp({credential: cert(serviceAccount)});

const db = getFirestore();

// Configura chiavi VAPID per Web Push nativo
webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

async function sendWebPushToSubscription(userId, subscription, title, body) {
    if (!subscription || typeof subscription !== 'object' || !subscription.endpoint) {
        return false;
    }

    try {
        await webpush.sendNotification(
            subscription,
            JSON.stringify({
                title,
                body,
                icon: '/icons/icon-192x192.png'
            }),
            {
                urgency: 'high',
                TTL: 3600
            }
        );
        return true;
    } catch (err) {
        console.error(`Errore web-push per ${userId} (status ${err.statusCode || 'n/a'}):`, err.message);

        //404 / 410 = sottoscrizione scaduta, non più valida o revocata
        if (err.statusCode === 404 || err.statusCode === 410) {
            try {
                await db.collection('users').doc(userId).update({ pushRegistered: false });
                console.log(`Sottoscrizione scaduta disattivata per l'utente ${userId}.`);
            } catch (updateErr) {
                console.error(`Errore aggiornamento pushRegistered per ${userId}:`, updateErr.message);
            }
        }
        return false;
    }
}

//Helper per invio notifiche ad un singolo utente
async function sendPushToUser(userId, title, body) {
    if (!userId) return;
    try {
        const userSnap = await db.collection('users').doc(userId).get();
        if (!userSnap.exists) return;

        const userData = userSnap.data();
        if (!userData.pushRegistered || !userData.pushSubscription) {
            console.log(`Utente ${userId} senza pushSubscription attiva.`);
            return;
        }

        const ok = await sendWebPushToSubscription(userId, userData.pushSubscription, title, body);
        if (ok) {
            console.log(`Push inviata a ${userId}: ${title}`);
        }
    } catch (err) {
        console.error(`Errore invio push a ${userId}: `, err.message);
    }
}

//Helper per invio notifiche a tutti gli utenti di un ruolo (socio/gestore)
async function sendPushToRole(targetRole, title, body) {
    try {
        const snap = await db.collection('users')
            .where('role', '==', targetRole)
            .where('pushRegistered', '==', true)
            .get();

        const targets = [];
        snap.forEach(doc => {
            const data = doc.data();
            if (data.pushSubscription && data.pushSubscription.endpoint) {
                targets.push({ id: doc.id, sub: data.pushSubscription });
            }
        });

        if (targets.length === 0) {
            console.log(`Nessuna sottoscrizione push attiva per il ruolo "${targetRole}".`);
            return;
        }

        const results = await Promise.all(
            targets.map(t => sendWebPushToSubscription(t.id, t.sub, title, body))
        );
        const successCount = results.filter(Boolean).length;
        console.log(`Push multicast (${targetRole}): ${successCount}/${targets.length} inviate - ${title}`);
    } catch (err) {
        console.error(`Errore multicast (${targetRole}): `, err.message);
    }
}

//Incordature
let initStringing = true;
const stringingCache = new Map(); //Memorizza lo stato precedente per rilevare il cambio

db.collection('stringingRequests').onSnapshot(snapshot => {
    if(initStringing){
        snapshot.forEach(doc => stringingCache.set(doc.id, doc.data()));
        initStringing = false;
        console.log('Listener incordature attivo');
        return;
    }

    snapshot.docChanges().forEach(async change => {
        const id = change.doc.id;
        const data = change.doc.data();
        const prev = stringingCache.get(id);
        stringingCache.set(id, data);

        //[Gestore] Nuova richiesta incordatura
        if(change.type === 'added'){
            await sendPushToRole(
                'gestore',
                'Nuova richiesta di incordatura',
                `${data.userName || 'Socio'} ha richiesto incordatura (${data.racketDetails || 'Racchetta'} - ${data.tension || ''} kg).`
            );
        }

        //Cambio stato su incordatura esistente
        if(change.type === 'modified' && prev && prev.status !== data.status){

            //[Socio] Incordatura completata
            if(data.status === 'Completata'){
                await sendPushToUser(
                    data.userId,
                    'Racchetta pronta',
                    `La tua ${data.racketDetails || 'racchetta'} è stata incordata ed è pronta per il ritiro.`
                );
            }

            if(data.status === 'Annullata'){
                //[Socio] Incordatura annullata dal circolo
                if(data.cancelledBy && data.cancelledBy !== data.userId){
                    await sendPushToUser(
                        data.userId,
                        'Incordatura annullata',
                        `La richiesta per la tua ${data.racketDetails || 'racchetta'} è stata annullata dal circolo.`
                    );
                } else if(data.cancelledBy === data.userId){ //[Gestore] Incordatura annullata dal socio
                    await sendPushToRole(
                        'gestore',
                        'Incordatura annullata dal socio',
                        `${data.userName || 'Un socio'} ha annullato la richiesta per ${data.racketDetails || 'racchetta'}.`
                    );
                }
            }
        }
    });
});

//Catalogo corde
let initStrings = true;

db.collection('stringCatalog').onSnapshot(snapshot => {
    if(initStrings){
        initStrings = false;
        console.log('Listener catalogo corde attivo');
        return;
    }

    snapshot.docChanges().forEach(async change => {
        if(change.type === 'modified' || change.type === 'added'){
            const data = change.doc.data();

            //[Gestore] Scorta bassa di una matassa
            if(typeof data.remainingJobs === 'number' && data.remainingJobs <= 5 && !data.lowStockNotified){
                await sendPushToRole(
                    'gestore',
                    'Scorta matassa corde bassa',
                    `La matassa ${data.brand || ''} ${data.model || ''} ${data.gauge || ''} ha solo ${data.remainingJobs} incordature rimanenti.`
                );
                //Segna come notificato per non ripetere l'avviso
                await db.collection('stringCatalog').doc(change.doc.id).update({lowStockNotified: true});
            }
        }
    });
});

//Prenotazioni campi
let initReservations = true;
const reservationsCache = new Map();

db.collection('reservations').onSnapshot(snapshot => {
    if(initReservations){
        snapshot.forEach(doc => reservationsCache.set(doc.id, doc.data()));
        initReservations = false;
        console.log('Listener prenotazioni attivo');
        return;
    }

    snapshot.docChanges().forEach(async change => {
        const id = change.doc.id;
        const data = change.doc.data();
        const prev = reservationsCache.get(id);
        reservationsCache.set(id, data);

        if(change.type === 'modified' && prev && prev.status === 'confermata' && data.status === 'annullata'){
            //[Socio] Prenotazione annullata dal circolo
            if(data.cancelledBy === 'gestore'){
                const motivo = data.cancellationReason ? ` Motivo: ${data.cancellationReason}` : '';
                await sendPushToUser(
                    data.userId,
                    'Prenotazione annullata dal circolo',
                    `La tua prenotazione del ${data.date} alle ${data.timeSlot} è stata cancellata.${motivo}`
                );
            }

            //[Gestore] Disdetta last-minute del socio (< 3 ore prima della prenotazione)
            if(data.cancelledBy === 'socio' && !data.isManagerReserved){
                const slotStart = new Date(`${data.date}T${data.timeSlot}:00`);
                const now = new Date();
                const diffHours = (slotStart - now) / (1000*60*60);

                if(diffHours > 0 && diffHours < 3){
                    await sendPushToRole(
                        'gestore',
                        'Disdetta campo last-minute',
                        `${data.userName || 'Un socio'} ha disdetto ${data.courtName || 'il campo'} di oggi alle ${data.timeSlot}.`
                    );
                }
            }
        }
    });
});

//[Socio] Promemoria prenotazione
//Controllo ogni 5 minuti
setInterval(async () => {
    try{
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];

        const snap = await db.collection('reservations')
            .where('status', '==', 'confermata')
            .where('date', '==', todayStr)
            .where('reminderSent', '==', false)
            .get();
        
        snap.forEach(async docSnap => {
            const data = docSnap.data();
            if(data.isManagerReserved) return;

            const slotStart = new Date(`${data.date}T${data.timeSlot}:00`);
            const diffMinutes = (slotStart - now) / (1000 * 60);

            //Se mancano meno di 60 minuti all'inizio invia la notifica
            if(diffMinutes > 0 && diffMinutes <= 60){
                await sendPushToUser(
                    data.userId,
                    'Promemoria prenotazione tra un\'ora',
                    `Ricorda la tua prenotazione alle ${data.timeSlot}.`
                );
                await db.collection('reservations').doc(docSnap.id).update({reminderSent: true});
            }
        });
    } catch(err){
        console.error('Errore promemoria: ', err.message);
    }
}, 5*60*1000); //Ogni 5 minuti

//Bacheca e Commenti
let initAnnouncements = true;
const watchedAnnouncements = new Set();

function watchAnnouncementComments(announcementId, announcementData){
    if(watchedAnnouncements.has(announcementId)) return;
    watchedAnnouncements.add(announcementId);

    let initComments = true;
    db.collection('announcements').doc(announcementId).collection('comments').onSnapshot(cSnap => {
        if(initComments){
            initComments = false;
            return;
        }
        cSnap.docChanges().forEach(async cChange => {
            if(cChange.type === 'added'){
                const comment = cChange.doc.data();
                //[Socio] Nuovo commento al proprio annuncio
                if(comment.authorId !== announcementData.authorId){
                    await sendPushToUser(
                        announcementData.authorId,
                        'Nuovo commento al tuo annuncio',
                        `${comment.authorName}: "${comment.text}"`
                    );
                }
            }
        });
    });
}

db.collection('announcements').onSnapshot(snapshot => {
    if(initAnnouncements){
        snapshot.forEach(doc => {
            const data = doc.data();
            if(data.type === 'member') watchAnnouncementComments(doc.id, data);
        });
        initAnnouncements = false;
        console.log('Listener bacheca e commenti attivo');
        return;
    }

    snapshot.docChanges().forEach(async change => {
        const data = change.doc.data();
        if(change.type === 'added'){
            //[Socio] Nuovo annuncio del circolo
            if(data.type === 'club'){
                await sendPushToRole(
                    'socio',
                    `${data.title}`,
                    data.content.length > 100 ? data.content.substring(0,97) + '...' : data.content
                );
            }
            //Attiva ascolto commenti se è un annuncio dei soci
            if(data.type === 'member'){
                watchAnnouncementComments(change.doc.id, data);
            }
        }
    });
});

//Nuovi utenti
let initUsers = true;
db.collection('users').onSnapshot(snapshot => {
    if(initUsers){
        initUsers = false;
        console.log('Listener nuovi utenti attivo');
        return;
    }

    snapshot.docChanges().forEach(async change => {
        if(change.type === 'added'){
            const data = change.doc.data();
            //[Gestore] Nuovo socio registrato
            if(data.role !== 'gestore'){
                const nomeCompleto = (data.nome && data.cognome) ? `${data.nome} ${data.cognome}` : (data.email || 'Nuovo utente');
                await sendPushToRole(
                    'gestore',
                    'Nuovo socio registrato',
                    `${nomeCompleto} si è appena registrato su TennisClub Hub.`
                );
            }
        }
    });
});

//Server HTTP per hosting
const app = express();
app.get('/', (req, res) => res.send('TennisClub Hub Push Server attivo'));
app.get('/health', (req, res) => res.status(200).json({status: 'ok', timestamp: new Date().toISOString()}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server notifiche in ascolto sulla porta ${PORT}`);
});