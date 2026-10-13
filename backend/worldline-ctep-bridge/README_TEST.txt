JAVA 11 BUILD
Deze bridge is gecompileerd voor Java 11 (class version 55) en is bedoeld voor jouw huidige POS-pc.

POSPOINT RX5000 TEST BRIDGE - CANCEL FIX

Deze bridge is bedoeld voor de RX5000 testtool.

Poorten
- C-TEP TCP: 9000
- HTTP API: 3210

Belangrijk
1. Sluit de oude Worldline bridge voordat je deze start.
2. Start START_TEST_BRIDGE.bat.
3. Wacht tot 'Terminal connected' in het zwarte venster verschijnt.
4. Controleer in de browser:
   http://127.0.0.1:3210/status
5. Start daarna de RX5000 TestTool v2 en klik STATUS.
6. Test vervolgens SALE + CANCEL.

Wat is aangepast in deze testbridge?
- POST /cancel zet cancelRequested=true.
- resetTransaction() wordt maximaal 1 keer verzonden per actieve transactie.
- transactionBusy blijft TRUE totdat de terminal de actieve SaleTransaction echt afrondt.
- 'Technical_Issue, ResetTransaction]' na een bewuste cancel wordt teruggegeven als:
    {"status":"cancelled","approved":false}
- Als de terminal alsnog een betaling goedkeurt na CANCEL, blijft dat zichtbaar als approved=true
  met een warning. Dit voorkomt een vals 'cancelled' resultaat.
- /status toont extra:
  cancelRequested, resetSent en activeTxId.

Logbestand
logs\ctep-browser-bridge.log

Stuur na de test dit logbestand samen met de log uit de testtool terug.
