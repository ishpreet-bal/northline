import sys
src=open(__import__('os').path.join(__import__('os').path.dirname(__file__),'northline-claude.html')).read()
head,body=src.split('<!--BODY-->',1)
page=('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
 '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
 '<meta name="description" content="A self-refreshing briefing of world, U.S., Canada and Ontario news with backstory and what it means for you.">\n'
 '<meta name="theme-color" content="#0b1015">\n'
 '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%230b1015%22/%3E%3Cpath d=%22M9 23V9l14 14V9%22 fill=%22none%22 stroke=%22%23efb449%22 stroke-width=%223%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E">\n'
 + head.strip() + '\n</head>\n<body>\n' + body.strip() + '\n</body>\n</html>\n')
open(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','index.html'),'w').write(page)
