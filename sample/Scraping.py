import os
import time
import datetime as dt
import pandas as pd
from urllib.request import urlopen
import requests
from bs4 import BeautifulSoup
import re
import csv
import sys
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.by import By


def scrape_horseResult(horse_id,driver):
    '''
    horseIDから情報取得、既に情報を持っている場合は更新しない
    '''
    path = './HorseResultLists'
    files = os.listdir(path)
    filelist = [s for s in files if os.path.splitext(s)[1] == '.pickle']

    if '{}.pickle'.format(horse_id) not in filelist:
        print('Scrape HorseResult {}'.format(horse_id))
        time.sleep(1)
        try:
            url = 'https://db.netkeiba.com/horse/' + horse_id
            driver.get(url)
            time.sleep(2)
            # ページ全体のHTMLテキストを取得
            html_text = driver.page_source
            df = pd.read_html(html_text)[3]
            #受賞歴がある馬の場合4番目のデータを取得する
            if df.columns[0]=='受賞歴':
                df = pd.read_html(html_text)[4]

            df.to_pickle('{}/{}.pickle'.format(path,horse_id))
        except Exception as e:
            print(e)

def scrape_horseResults(horse_id_list,driver):
    '''
    horseIDのリストから情報取得、既に情報を持っている場合は更新しない
    '''
    path = './HorseResultLists'
    files = os.listdir(path)
    filelist = [s for s in files if os.path.splitext(s)[1] == '.pickle']
    convfl = []

    #保存済みの馬IDを検索
    for file in filelist:
        convfl.append(file.replace('.pickle',''))

    # 今回取得する馬IDが既に取得済みならIDを削る
    for s in convfl:
        if s in horse_id_list:
            horse_id_list.remove(s)

    # 未登録馬IDの情報をスクレイピングして保存
    for horse_id in horse_id_list:
        time.sleep(1)
        try:
            url = 'https://db.netkeiba.com/horse/' + horse_id
            driver.get(url)
            time.sleep(1)
            # ページ全体のHTMLテキストを取得
            html_text = driver.page_source
            df = pd.read_html(html_text)[3]
            #受賞歴がある馬の場合4番目のデータを取得する
            if df.columns[0]=='受賞歴':
                df = pd.read_html(html_text)[4]

            df.to_pickle('{}/{}.pickle'.format(path,horse_id))
        except IndexError:
            continue
        except Exception as e:
            print(e)
            break
        except:
            break

def scrape_horseResult_update(horse_id_list,driver):
    '''
    horseIDから情報取得情報を上書きする
    '''
    path = './HorseResultLists'

    # 馬IDの情報をスクレイピングして保存
    for horse_id in horse_id_list:
        time.sleep(1)
        try:
            url = 'https://db.netkeiba.com/horse/' + horse_id
            driver.get(url)
            time.sleep(1)
            # ページ全体のHTMLテキストを取得
            html_text = driver.page_source
            df = pd.read_html(html_text)[3]
            #受賞歴がある馬の場合4番目のデータを取得する
            if df.columns[0]=='受賞歴':
                df = pd.read_html(html_text)[4]

            df.to_pickle('{}/{}.pickle'.format(path,horse_id))
        except IndexError:
            continue
        except Exception as e:
            print(e)
            break
        except:
            break

def scrape_race_to_horseid(race_id_list,driver):
    '''
    raceIDからhorseIDを取得する
    '''
    horseids = pd.DataFrame()
    class_list = []
    for race_id in race_id_list:
        time.sleep(1)
        try:
            url = 'https://race.netkeiba.com/race/shutuba.html?race_id=' + race_id
            driver.get(url)
            time.sleep(1)
            # ページ全体のHTMLテキストを取得
            html_text = driver.page_source
            soup = BeautifulSoup(html_text, "html.parser")

            # horse_id
            horse_td_list = soup.find_all("td", attrs={'class': 'HorseInfo'})
            dic = {}
            for td in horse_td_list:
                horse_id = re.findall(r'\d+', td.find('a')['href'])[0]
                horse_name = td.find('span',attrs={'class': 'HorseName'}).text
                dic[horse_id] = [horse_id, horse_name]

            dfs = pd.DataFrame.from_dict(dic,orient='index')
            dfs.index = [race_id] * len(dfs)

            horseids = pd.concat([horseids,dfs])
        except Exception as e:
            print('type:' + str(type(e)))
            print('args:' + str(e.args))
            print('message:' + e.message)
            print('e:' + str(e))

    return horseids

def scrape_date_to_raceidlist(date,driver):
    '''
    日付からraceIDを取得する
    '''
    df_total = pd.DataFrame()
    race_id_list = []
    url = 'https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=' + date
    driver.get(url)
    time.sleep(1)
    # ページ全体のHTMLテキストを取得
    html_text = driver.page_source
    soup = BeautifulSoup(html_text, "html.parser")

    a_list = soup.find_all('a')

    for a in a_list:
        href = re.findall(r'\d+', a['href'])[0]
        if len(href) == 12:
            race_id_list.append(href)

    if len(race_id_list) == 0:
        return race_id_list

    #重複削除
    race_id_list = list(set(race_id_list))
    race_id_list.sort()

    return race_id_list

def GetNextSaturday():
    '''
    次の土曜日を文字列で返す
    YYYYMMDD

    月火水木金土：0123456
    '''
    weekday = dt.datetime.now().weekday()
    add_days = 0
    if weekday >= 5:
        add_days = 12 - weekday
    else:
        add_days = 5 - weekday
    nextSaturday = dt.datetime.now() + dt.timedelta(days=add_days)

    return nextSaturday.strftime('%Y%m%d')

def GetNearSaturday():
    '''
    直近の土曜日を文字列で返す
    YYYYMMDD

    月火水木金土：0123456
    '''
    weekday = dt.datetime.now().weekday()
    add_days = 0
    add_days = 5 - weekday
    nearSaturday = dt.datetime.now() + dt.timedelta(days=add_days)

    return nearSaturday.strftime('%Y%m%d')

if __name__ == '__main__':
    args = sys.argv
    date = ''
    enddate = ''
    date_format = '%Y%m%d'

    # ChromeDriverの自動管理を使用
    options = Options()
    # SSLエラー対策
    options.add_argument('--ignore-certificate-errors')
    options.add_argument('--ignore-ssl-errors')
    options.add_argument('--allow-insecure-localhost')

    # ウィンドウサイズの設定
    options.add_argument('--window-size=200,200')  # 幅400px、高さ400px

    # 安定性のための設定
    options.add_argument('--disable-gpu')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')

    # FFmpegエラーメッセージを抑制したい場合は以下を追加
    options.add_argument('--disable-logging')
    options.add_experimental_option('excludeSwitches', ['enable-logging'])

    # WebGLエラー対策
    options.add_argument('--enable-unsafe-swiftshader')  # SwiftShaderを有効化[1]
    options.add_argument('--ignore-gpu-blocklist')  # GPUブロックリストを無視
    
    # WebDriverManagerは不要になり、直接ChromeDriverを初期化できる
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 10)  # タイムアウト10秒

    # 引数なしなら次の土曜日から２日間
    if len(args) == 1:
        date = GetNextSaturday()
        d = dt.datetime.strptime(date,date_format)
        dd = dt.timedelta(days=1)
        d = d + dd
        enddate = d.strftime(date_format)
    else:
        # １文字のときは〇〇日後のアイテムを取得
        if len(args[1]) == 1:
            d = dt.datetime.now()
            dd = dt.timedelta(days=int(args[1]))
            d = d + dd
            enddate = date = d.strftime(date_format)
        else:
            date = args[1]
            enddate = args[2]

    print(f'{date} to {enddate}')

    while date <= enddate:
        print('get race ids')
        print(date)
        raceids = scrape_date_to_raceidlist(date,driver)

        if len(raceids) > 0:
            print('get horse ids')
            horseids = scrape_race_to_horseid(raceids,driver)
            horse_id_list = []
            for ds,row in horseids.iterrows():
                horse_id_list.append(row[0])
            if len(horse_id_list) > 0:
                scrape_horseResult_update(horse_id_list,driver)

        #日付を１日進める
        d = dt.datetime.strptime(date,date_format)
        dd = dt.timedelta(days=1)
        d = d + dd
        date = d.strftime(date_format)

    driver.quit()
    print('finish')
