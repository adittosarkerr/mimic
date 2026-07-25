import nodemailer from 'nodemailer'
const B = 'http://localhost:4545/api'
// login tester (or register)
let tok = ''
const login = await (await fetch(`${B}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'tester@mimic.test',password:'testpass123'})})).json()
if (login.token) tok = login.token
else { const reg = await (await fetch(`${B}/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'tester@mimic.test',password:'testpass123'})})).json(); tok = reg.token }
console.log('token?', !!tok)
// ethereal config
const acct = await nodemailer.createTestAccount()
const save = await (await fetch(`${B}/email/config`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:JSON.stringify({email:acct.user,appPassword:acct.pass,provider:'custom',host:acct.smtp.host,port:acct.smtp.port,secure:acct.smtp.secure})})).json()
console.log('config saved:', JSON.stringify(save))
// find the email automation
const aid = process.argv[2]
const send = await fetch(`${B}/automations/${aid}/send-email`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:JSON.stringify({values:{to_recipients:'dest@example.com',subject:'From mimic endpoint',message_body:'It really works.'}})})
const sj = await send.json()
console.log('send-email:', send.status, JSON.stringify(sj).slice(0,200))
