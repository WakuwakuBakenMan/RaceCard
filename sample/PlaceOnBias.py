import time
import pandas as pd
from urllib.request import urlopen
import requests
from bs4 import BeautifulSoup
import re
import csv
import os
import datetime as dt
import sys
import Scraping
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException
from datetime import datetime, timedelta
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

# ChromeDriverの自動管理を使用
options = Options()
options.add_argument('--headless')  # ヘッドレスモードの場合

# WebDriverManagerは不要になり、直接ChromeDriverを初期化できる
driver = webdriver.Chrome(options=options)
course_dict = {'01':'札幌','02':'函館','03':'福島','04':'新潟','05':'東京','06':'中山','07':'中京','08':'京都','09':'阪神','10':'小倉'}

def check_file_date(file_path):

    # ファイルが存在しない場合はFalseを返す
    if not os.path.exists(file_path):
        return False
    
    # ファイルの最終更新日を取得
    modify_time = os.path.getmtime(file_path)
    modify_date = datetime.fromtimestamp(modify_time).date()

    # 現在の日付を取得
    today = datetime.now().date()

    # 日付の差を計算
    date_diff = today - modify_date

    # 日付の差が3日以内であればTrue、3日以上前であればFalseを返す
    return date_diff < timedelta(days=3)

def scrape_syutuba(race_id_list,driver):
    data = pd.DataFrame()
    class_list = []
    race_length_list = []
    race_type_list = []
    url_list = []

    for race_id in (race_id_list):
        time.sleep(5)
        url = 'https://race.netkeiba.com/race/shutuba.html?race_id=' + race_id
        try:
            driver.get(url)
        except TimeoutException:
            print("Timeout error. Loading interrupted.")
        time.sleep(5)
        # ページ全体のHTMLテキストを取得
        html_text = driver.page_source
        soup = BeautifulSoup(html_text, "html.parser")

        # horse_id
        horse_tr_list = soup.select("tr[class='HorseList']")
        horse_td_list = soup.find_all("td", attrs={'class': 'HorseInfo'})
        dic = {}
        for tr in horse_tr_list:
            td = tr.find('td',class_='HorseInfo')
            # データ変更対策 20250117
            if td is not None:
                horse_id = re.findall(r'\d+', td.find('a')['href'])[0]
                horse_name = td.find('span',attrs={'class': 'HorseName'}).text
                dic[horse_id] = [horse_id, horse_name]

        dfs = pd.DataFrame.from_dict(dic,orient='index')
        dfs.index = [race_id] * len(dfs)

        dfs.index = [race_id] * len(dfs)
        data = pd.concat([data,dfs])

        #class name
        race_name = soup.find("h1", attrs={'class': 'RaceName'})
        class_list.append(race_name.text.strip('\n'))

        #race length type
        length = soup.find_all("div", attrs={'class': 'RaceData01'})[0].find("span").text
        #race length
        race_len = re.sub(r'\D','',length)
        race_length_list.append(race_len)
        #race type
        race_type = re.sub(r'\d','',length).strip().strip('m')
        race_type_list.append(race_type)
        #url
        url_list.append(url)

    return data,class_list,race_length_list,race_type_list,url_list

def scrape_horse(horse_id_list,date,driver):
    #追加 210716
    target2_horse_list = []
    target1_horse_list = []
    nige_horse_list = []
    #逃げ馬頭数
    nigeuma = 0
    #展開バイアスカウント
    PlcOnCnt = 0.0
    #カウンターリセット
    i = 0
    #各馬情報取得
    # 250320 horse result data 再取得のためForからWhileに変更
    #    for horse_id in horse_id_list:
    while i < len(horse_id_list):
        horse_id = horse_id_list[i]
        try:
            file_path = f'./HorseResultLists/{horse_id}.pickle'
            # 取得データが3日以内であればpickleファイルから取得
            if check_file_date(file_path):
                i = i + 1
                #馬の結果データはpickleファイルから取得
                if os.path.exists(f'./HorseResultLists/{horse_id}.pickle'):
                    df = pd.read_pickle(f'./HorseResultLists/{horse_id}.pickle')
                else:
                    print(f'Horse {horse_id} has no data')
                    continue

                # 新馬でデータがない場合はスキップ
                if df.empty:
                    print(f'Horse {horse_id} has empty data')
                    continue

                required_columns = {'通過'}
                if not required_columns <= set(df.columns):
                    continue

                #レース当日までのデータは削除
                ddd = date[0:4] + '/' + date[4:6] + '/' + date[6:8]
                passageslist = []
                for d,row in df.iterrows():
                    date1 = time.strptime(row[0],"%Y/%m/%d")
                    date2 = time.strptime(ddd,"%Y/%m/%d")
                    if date1 < date2:
                        passageslist.append(row['通過'])

                #各馬近走３レース分のみ取得
                cnt = 0
                #全コーナー４番手以内回数
                Allpas4cnt = 0
                #逃げた回数
                nigecnt = 0
                for passages in passageslist:
                    # 出走取消等は除外
                    if type(passages) != str:
                        continue
                    # 通過順をリストで取得
                    passage = passages.split('-')
                    #文字列を数値に変換
                    l_passage = [int(s) for s in passage]
                    #各コーナーの最大値が４以下であればAll4カウント
                    if max(l_passage) <= 4:
                        Allpas4cnt = Allpas4cnt + 1
                    #先頭に１があれば逃げたと判定 → 20250308変更
                    #if l_passage[0] == 1:
                    #通過が１つのときは先頭のみ判定　→　20230524変更
                    if len(l_passage ) == 1:
                        if l_passage[0] == 1:
                            nigecnt = nigecnt + 1
                    #先頭1または最初の値が2以下で他が1のとき逃げたと判定
                    else:
                        if l_passage[0] == 1 or (l_passage[0] == 2 and l_passage[1] == 1):
                            nigecnt = nigecnt + 1
                    cnt = cnt + 1
                    if cnt >= 3:
                        break

                #全コーナー４番手以内回数が２以上なら
                if Allpas4cnt >= 2:
                    PlcOnCnt = PlcOnCnt + 1
                    #追加 210716
                    target2_horse_list.append(horse_id)
                #全コーナー４番手以内回数が１なら
                elif Allpas4cnt == 1:
                    PlcOnCnt = PlcOnCnt + 0.5
                    #追加 210716
                    target1_horse_list.append(horse_id)
                #逃げた回数が２回以上ならカウント
                if nigecnt >= 2:
                    nigeuma = nigeuma + 1
                    #追加 210716
                    nige_horse_list.append(horse_id)
                
                # カウンターを進める
            else:
                # 再度スクレイピング、カウンターは進めず再度処理を行う
                print(f'Update data : Horse {horse_id}')
                Scraping.scrape_horseResult_update(horse_id, driver)

        except IndexError:
            continue
        except Exception as e:
            print(e)
            break
        except:
            break

    #逃げ馬の数での調整
    if nigeuma == 0:
        # 20250607 逃げ馬がいないときのカウントを-1.5から-2.5に変更
        PlcOnCnt = PlcOnCnt - 2.5
    elif nigeuma >= 2:
        PlcOnCnt = PlcOnCnt + 1.5

    #20210102追加
    #先行馬の数での調整
    if len(target2_horse_list) <= 2:
        PlcOnCnt = PlcOnCnt - 1.0

    return PlcOnCnt, target2_horse_list, target1_horse_list, nige_horse_list
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
    #options.add_argument('--window-size=200,200')  # 幅400px、高さ400px

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
    # wait = WebDriverWait(driver, 10)  # タイムアウト10秒
    driver.set_page_load_timeout(180)  # 最大180秒待機する

    #netkeibaログイン
    driver.get('https://regist.netkeiba.com/account/?pid=login')
    time.sleep(5)
    driver.find_element(by='name',value='login_id').send_keys('kokobongu@gmail.com')
    driver.find_element(by='name',value='pswd').send_keys('keibacom1212')

    # 要素が見つかるまで待機（最大10秒）
    element = WebDriverWait(driver, 10).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, "#contents > div > form > div > div.loginBtn__wrap > input[type=image]"))
    )
    # 要素をクリック
    element.click()
    time.sleep(5)

    # 引数なしなら直近の土曜日から２日間
    if len(args) == 1:
        date = Scraping.GetNearSaturday()
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
        df_total = pd.DataFrame()
        race_id_list = []
        time.sleep(10)
        url = 'https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=' + date
        try:
            driver.get(url)
        except TimeoutException:
            print("Timeout error. Loading interrupted.")
        time.sleep(5)
        # ページ全体のHTMLテキストを取得
        html_text = driver.page_source
        soup = BeautifulSoup(html_text, "html.parser")

        a_list = soup.find_all('a')

        for a in a_list:
            href = re.findall(r'\d+', a['href'])[0]
            if len(href) == 12:
                race_id_list.append(href)

        if len(race_id_list) == 0:
            continue

        #重複削除
        race_id_list = list(set(race_id_list))
        race_id_list.sort()

        syutuba_list,class_list,race_length_list,race_type_list,url_list = scrape_syutuba(race_id_list,driver)

        placeonbiases = []
        for race_id in race_id_list:
            s_race =  syutuba_list.loc[race_id]
            placecnt = 0.0
            horse_id_list = []
            for ds,row in s_race.iterrows():
                horse_id_list.append(row[0])

            # 展開バイアス算出
            placecnt,target2_list,target1_list,nige_list = scrape_horse(horse_id_list,date,driver)
            placeonbiases.append([race_id,placecnt,target2_list,target1_list,nige_list])

        i = 0

        f = open("./BiasFiles/{}.txt".format(date), "w")

        print('{yyyy}/{mm}/{dd} 展開バイアス'.format(yyyy=date[:4],mm=date[4:6],dd=date[6:8]),file=f)
        print('',file=f)
        print('◎　展開バイアス発生レース',file=f)
        print('',file=f)
        print('数値が低ければ低いほど前が楽できる展開であることを意味します。',file=f)
        print('',file=f)
        for placeonbias in placeonbiases:
            rindex = placeonbias[0]
            biasonoff = ""
            #20240530レース距離による展開バイアスありなし補正
            #20250607レース不問で4.0以下を展開ありに変更
            if placeonbias[1] > 4.0:
                biasonoff = "なし"
            else:
                if placeonbias[1] == -3.5:
                    biasonoff = "無効"
                else:
                    biasonoff = "展開バイアス"
                    print(course_dict[rindex[4:6]] + ' ' + rindex[-2:] + 'R ' + biasonoff + '：' + str(placeonbias[1]) + ' ' + class_list[i].strip() + ' ' + race_type_list[i] + race_length_list[i] + 'm' ,file=f)

            i = i + 1
        print('',file=f)
        print('※補足',file=f)
        print('',file=f)
        print('▼近３走中２回以上全角４以内馬とは',file=f)
        print('近3走のうち2回以上全コーナー4番手以内を通過している馬のことです。',file=f)
        print('',file=f)
        print('◆近３走中１回全角４以内馬とは',file=f)
        print('近3走のうち1回だけ全コーナー4番手以内を通過している馬のことです。',file=f)
        print('',file=f)
        print('★近３走中２走逃げ馬',file=f)
        print('近3走のうち2回以上逃げている馬のことです。',file=f)
        print('',file=f)

        i = 0
        for placeonbias in placeonbiases:
            rindex = placeonbias[0]
            biasonoff = ""
            if placeonbias[1] > 4.0:
                biasonoff = "なし"
            else:
                if placeonbias[1] == -3.5:
                    biasonoff = "無効"
                else:
                    biasonoff = "展開バイアス"


            print(course_dict[rindex[4:6]] + ' ' + rindex[6:8] + '回 ' + rindex[8:10] + '日目 ' + rindex[-2:] + 'R ' + ' ' + race_type_list[i] + race_length_list[i] + 'm ' + class_list[i].strip() + '：' + str(placeonbias[1]),file=f)

            if len(placeonbias[2]) > 0:
                print('▼近３走中２回以上全角４以内馬',file=f)
                for house_id in placeonbias[2]:
                    for d,row in syutuba_list.iterrows():
                        if row[0] == house_id:
                            print(row[1],file=f)
            if len(placeonbias[3]) > 0:
                print('◆近３走中１回全角４以内馬',file=f)
                for house_id in placeonbias[3]:
                    for d,row in syutuba_list.iterrows():
                        if row[0] == house_id:
                            print(row[1],file=f)
            if len(placeonbias[4]) > 0:
                print('★近３走中２走逃げ馬',file=f)
                for house_id in placeonbias[4]:
                    for d,row in syutuba_list.iterrows():
                        if row[0] == house_id:
                            print(row[1],file=f)

            print('',file=f)
            i = i + 1

        i = 0
        print('↓↓↓以下投稿用データ↓↓↓',file=f)
        print('{yyyy}/{mm}/{dd} 展開バイアス'.format(yyyy=date[:4],mm=date[4:6],dd=date[6:8]),file=f)
        print('',file=f)
        print('◎　展開バイアス発生レース',file=f)
        print('',file=f)
        print('数値が低ければ低いほど前が楽できる展開であることを意味します。',file=f)
        print('',file=f)
        for placeonbias in placeonbiases:
            rindex = placeonbias[0]
            biasonoff = ""
            #20240530レース距離による展開バイアスありなし補正
            #20250607レース不問で4.0以下を展開ありに変更
            if placeonbias[1] > 4.0:
                biasonoff = "なし"
            else:
                if placeonbias[1] == -3.5:
                    biasonoff = "無効"
                else:
                    biasonoff = "展開バイアス"
                    print(course_dict[rindex[4:6]] + ' ' + rindex[-2:] + 'R ' + biasonoff + '：' + str(placeonbias[1]) + ' ' + class_list[i].strip() + ' ' + race_type_list[i] + race_length_list[i] + 'm' ,file=f)
                    print(url_list[i],file=f)
            i = i + 1
        f.close()

        #日付を１日進める
        d = dt.datetime.strptime(date,date_format)
        dd = dt.timedelta(days=1)
        d = d + dd
        date = d.strftime(date_format)

    driver.quit()
    print(f'{date} to {enddate} finish')
