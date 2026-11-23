// Package fileservice es el SDK de servidor (Go) del File Service de ntropix.
//
// Se usa SOLO en el backend del Proyecto: la API key nunca debe llegar al navegador. El navegador
// sube los bytes directo al storage con URLs firmadas que el backend obtiene del servicio.
//
// Tres piezas cubren casi todos los usos:
//
//   - [Client]: la API REST (crear subidas, completar, consultar, listar, papelera…), con
//     reintentos automáticos en las operaciones que es seguro repetir.
//   - [Client.HandleUpload] / [Client.UploadHandler]: el endpoint de subida que habla el protocolo
//     del helper de navegador (@ntropix/file-service/browser). Es el mismo protocolo en todos los
//     SDKs, así que el mismo helper funciona contra un backend Go.
//   - [VerifyWebhook]: verifica la firma FS-Signature de los webhooks salientes del servicio.
//
// El usuario final que origina una acción se informa con [WithActor]: viaja en el header FS-Actor
// y solo queda en la auditoría.
//
// Los errores de la API son [*Error] (con un Code estable); un archivo rechazado por la
// verificación es [*RejectedError]. Ambos se inspeccionan con errors.As.
package fileservice
